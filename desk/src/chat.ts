import { randomUUID } from "node:crypto";
import { jsonText, type Llm } from "@jeirslab/llm-client";

/** Parley chat: conversations, memory, UI actions and staged PayPal calls (never executed here). */

export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface CaseCtx {
  id: string;
  buyer: string;
  amount_cents: number;
  currency: string;
  reason: string;
  item?: string;
  call: string | null;
  p?: number;
  interval?: [number, number];
  offer_cents?: number;
  keep_cents?: number;
  missing_evidence?: string[];
  draft_text?: string | null;
}

export interface ChatDeps {
  pool: Db;
  llm: Llm;
  /** one case with its decision, or null when the id is unknown */
  loadCase: (id: string) => Promise<CaseCtx | null>;
  /** the cases the seller can see, for filters and context */
  listCases: () => Promise<
    {
      id: string;
      buyer: string;
      item?: string;
      amount_cents: number;
      call: string | null;
      offer_cents?: number | null;
      currency?: string;
      p?: number | null;
      reason?: string;
      due_in_days?: number | null;
      /** ISO due time; the chat turns it into calendar days the way the list does */
      due_at?: string | null;
      /** cents of the offer already sent on this case, when one was */
      sent_offer_cents?: number | null;
      /** 'needs_you' for the desk's "Disputes that need you" list (open), else 'waiting' (sent or under review) */
      status_group?: "needs_you" | "waiting";
    }[]
  >;
}

export interface Staged {
  id: string;
  kind:
    "make_dispute_offer" | "provide_dispute_evidence" | "accept_dispute_claim";
  title: string;
  /** a line shown above the buttons when the amount differs from the desk's call */
  note?: string;
  paypal: { method: "POST"; path: string; body: Record<string, unknown> };
  desk: { method: "POST"; path: string; body: Record<string, unknown> };
}
export type UiAction =
  | { type: "select_case"; id: string }
  | { type: "open_tab"; tab: string }
  | { type: "filter"; ids: string[] | null }
  | { type: "highlight_evidence" };

const D = "/v1/customer/disputes";
const OFFER_TYPES = [
  "REFUND",
  "REFUND_WITH_RETURN",
  "REFUND_WITH_REPLACEMENT",
  "REPLACEMENT_WITHOUT_REFUND",
];
export const money = (c: number, cur = "USD") =>
  `${cur === "USD" ? "$" : cur + " "}${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// wording copied from the web app's format.ts (REASON_SHORT, REASONS); no web imports on the server
const REASON_WORDS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorised",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  CREDIT_NOT_PROCESSED: "Refund not processed",
  OTHER: "Other",
  PROBLEM_WITH_REMITTANCE: "Payment problem",
  PAYMENT_BY_OTHER_MEANS: "Paid another way",
  CANCELED_RECURRING_BILLING: "Cancelled subscription",
};
export const reasonWords = (r = "") =>
  REASON_WORDS[r] ??
  (r
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^./, (m) => m.toUpperCase()) ||
    "Unknown");
/** "Ember 20F Sleeping Bag · Marcus Bell · $179.00": how replies name a case. */
export const caseLabel = (c: {
  buyer: string;
  item?: string;
  amount_cents: number;
  currency?: string;
}) =>
  [c.item, c.buyer, money(c.amount_cents, c.currency)]
    .filter(Boolean)
    .join(" · ");

/** Replaces case ids in visible text with their labels (ids stay in actions). */
export function labelIds(
  text: string,
  cases: (Parameters<typeof caseLabel>[0] & { id: string })[],
): string {
  let out = text;
  for (const c of [...cases].sort((a, b) => b.id.length - a.id.length))
    out = out.split(c.id).join(caseLabel(c));
  for (const c of cases) {
    const l = caseLabel(c);
    out = out.split(`${l} (${l})`).join(l);
  }
  return out.replace(/ \(PP-D-[A-Za-z0-9-]+\)/g, "");
}

/** The desk's call in words a seller uses. */
export const callWords = (
  call: string | null | undefined,
  offer?: number,
  cur = "USD",
) =>
  call === "fight"
    ? "Fight it"
    : call === "accept"
      ? "Refund in full"
      : offer !== undefined && offer > 0
        ? `Offer ${money(offer, cur)} back`
        : "no call yet";

/** shortcut: tolerant parse of the model's {reply, actions}; plain text becomes the reply */
export function parseReply(content: string): {
  reply: string;
  actions: unknown[];
} {
  try {
    const o = JSON.parse(jsonText(content));
    if (o && typeof o === "object" && typeof o.reply === "string")
      return {
        reply: o.reply.trim(),
        actions: Array.isArray(o.actions) ? o.actions : [],
      };
  } catch {
    /* plain text */
  }
  return { reply: content.trim(), actions: [] };
}

/** PayPal Agent Toolkit names; the first names are what conversations stored before the rename hold */
const ALIAS: Record<string, string> = {
  make_offer: "make_dispute_offer",
  provide_evidence: "provide_dispute_evidence",
  accept_claim: "accept_dispute_claim",
  get_dispute: "select_case",
};

type ListedCase = Awaited<ReturnType<ChatDeps["listCases"]>>[number];
const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "offer",
  "refund",
  "send",
  "where",
  "they",
  "this",
  "that",
  "dispute",
  "case",
]);
const REASON_PHRASES: Record<string, string[]> = {
  UNAUTHORISED: ["unauthorised", "unauthorized"],
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: [
    "not received",
    "never arrived",
    "didn't arrive",
  ],
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: ["not as described"],
  DUPLICATE_TRANSACTION: ["duplicate"],
  CREDIT_NOT_PROCESSED: ["refund not processed", "credit not processed"],
  PAYMENT_BY_OTHER_MEANS: ["paid another way", "paid another", "other means"],
  CANCELED_RECURRING_BILLING: ["cancelled", "canceled"],
};

/** Cases the text names best: item words, buyer name, reason words, amount. Empty when nothing matches. */
export const resolveCase = (userText: string, cases: ListedCase[]): string[] =>
  rankCases(userText, cases).ids;
export function rankCases(
  userText: string,
  cases: ListedCase[],
): { ids: string[]; top: number } {
  const t = userText.toLowerCase();
  const words = new Set(t.match(/[a-z0-9']+/g) ?? []);
  const nums = new Set(
    (t.replaceAll(",", "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number),
  );
  const score = (c: ListedCase) => {
    let n = 0;
    for (const w of (c.item ?? "").toLowerCase().match(/[a-z]{3,}/g) ?? [])
      if (!STOP.has(w) && words.has(w)) n += 1;
    for (const w of c.buyer.toLowerCase().match(/[a-z]{2,}/g) ?? [])
      if (words.has(w)) n += 2;
    if ((REASON_PHRASES[c.reason ?? ""] ?? []).some((p) => t.includes(p)))
      n += 3;
    if (nums.has(c.amount_cents / 100)) n += 4;
    return n;
  };
  const scored = cases.map((c) => [c, score(c)] as const);
  const top = Math.max(0, ...scored.map(([, n]) => n));
  return {
    ids: top ? scored.filter(([, n]) => n === top).map(([c]) => c.id) : [],
    top,
  };
}

const isOpen = (c: ListedCase) => c.status_group !== "waiting";
const TABS = ["overview", "evidence", "buyer", "timeline", "draft", "math"];

/** Turns raw model actions into allowed ones; staged actions are described, never run. */
export async function validateActions(
  raw: unknown[],
  deps: Pick<ChatDeps, "loadCase" | "listCases">,
  openCase?: string,
  userText?: string,
): Promise<{
  ui: UiAction[];
  staged: Staged[];
  remember: string[];
  /** ids the text matched equally; nothing was staged for them */
  ambiguous?: string[];
  /** the offer the text asked for is already out; nothing was staged */
  already?: string;
}> {
  let ambiguous: string[] | undefined;
  let already: string | undefined;
  const ui: UiAction[] = [];
  const staged: Staged[] = [];
  const remember: string[] = [];
  for (const a of raw.slice(0, 6)) {
    if (!a || typeof a !== "object") continue;
    const x = { ...(a as Record<string, unknown>) };
    const t = typeof x["type"] === "string" ? x["type"] : "";
    x["type"] = ALIAS[t] ?? t;
    if (t === "get_dispute" && x["id"] === undefined) x["id"] = x["case_id"];
    const str = (k: string) =>
      typeof x[k] === "string" ? (x[k] as string) : "";
    switch (x["type"]) {
      case "select_case":
        if (await deps.loadCase(str("id")))
          ui.push({ type: "select_case", id: str("id") });
        break;
      case "open_tab":
        if (TABS.includes(str("tab").toLowerCase()))
          ui.push({ type: "open_tab", tab: str("tab").toLowerCase() });
        break;
      case "filter": {
        if (x["ids"] === null) {
          ui.push({ type: "filter", ids: null });
          break;
        }
        if (!Array.isArray(x["ids"])) break;
        const known = new Set((await deps.listCases()).map((c) => c.id));
        const ids = x["ids"].filter(
          (i): i is string => typeof i === "string" && known.has(i),
        );
        ui.push({ type: "filter", ids });
        break;
      }
      case "highlight_evidence":
        ui.push({ type: "highlight_evidence" });
        break;
      case "remember": {
        const f = str("fact").trim().slice(0, 300);
        if (f) remember.push(f);
        break;
      }
      case "list_disputes":
        break; // read tool: the case list is already in the model's context
      case "make_dispute_offer":
      case "provide_dispute_evidence":
      case "accept_dispute_claim": {
        let id = str("case_id") || openCase || "";
        if (userText) {
          const all = await deps.listCases();
          const open = all.filter(isOpen);
          // a money action resolves to cases that can take it first: open ones whose call is the offer
          const offers =
            x["type"] === "make_dispute_offer"
              ? rankCases(
                  userText,
                  open.filter((c) => c.call === "offer"),
                )
              : { ids: [], top: 0 };
          const hit = offers.ids.length
            ? offers.ids
            : resolveCase(userText, open);
          if (x["type"] === "make_dispute_offer") {
            // a sent offer that fits the words better than any open one: say so instead of asking
            const sent = rankCases(
              userText,
              all.filter((c) => c.sent_offer_cents),
            );
            const c = all.find((y) => y.id === sent.ids[0]);
            if (
              sent.ids.length === 1 &&
              c &&
              sent.top > offers.top &&
              !(hit.length === 1 && !offers.ids.length)
            ) {
              already = `You already offered ${money(c.sent_offer_cents!, c.currency)} on that one.`;
              break;
            }
          }
          if (hit.length > 1) {
            ambiguous = hit;
            break;
          }
          if (hit.length === 1) id = hit[0]!;
        }
        const c = id ? await deps.loadCase(id) : null;
        if (!c) break;
        const staged0 = staged.length;
        const on = c.item ? `the ${c.item} dispute` : "this dispute";
        const base = `${D}/${encodeURIComponent(c.id)}`;
        const cp = `/api/cases/${encodeURIComponent(c.id)}`;
        if (x["type"] === "make_dispute_offer") {
          const cents =
            x["amount_cents"] === undefined ? c.offer_cents : x["amount_cents"];
          if (
            !Number.isInteger(cents) ||
            (cents as number) <= 0 ||
            (cents as number) >= c.amount_cents
          )
            break;
          const offerType = OFFER_TYPES.includes(str("offer_type"))
            ? str("offer_type")
            : "REFUND";
          const note =
            c.call === "fight" || c.call === "accept"
              ? `Parley's call on this case is ${callWords(c.call)}.`
              : c.offer_cents !== undefined && c.offer_cents !== cents
                ? `Parley suggests ${money(c.offer_cents, c.currency)}; you asked ${money(cents as number, c.currency)}.`
                : undefined;
          staged.push({
            id: randomUUID(),
            kind: "make_dispute_offer",
            ...(note ? { note } : {}),
            title: `Offer ${money(cents as number, c.currency)} back to ${c.buyer} on ${on}`,
            paypal: {
              method: "POST",
              path: `${base}/make-offer`,
              body: {
                offer_amount: {
                  currency_code: c.currency,
                  value: ((cents as number) / 100).toFixed(2),
                },
                offer_type: offerType,
              },
            },
            desk: {
              method: "POST",
              path: `${cp}/offer`,
              body: {
                confirm: true,
                amount_cents: cents,
                offer_type: offerType,
              },
            },
          });
        } else if (x["type"] === "accept_dispute_claim") {
          staged.push({
            id: randomUUID(),
            kind: "accept_dispute_claim",
            title: `Accept ${c.buyer}'s claim of ${money(c.amount_cents, c.currency)} on ${on}`,
            paypal: {
              method: "POST",
              path: `${base}/accept-claim`,
              body: { note: "Seller accepts the claim." },
            },
            desk: {
              method: "POST",
              path: `${cp}/accept`,
              body: { confirm: true },
            },
          });
        } else {
          const text = c.draft_text?.trim();
          ui.push({ type: "open_tab", tab: "draft" });
          if (!text) break;
          staged.push({
            id: randomUUID(),
            kind: "provide_dispute_evidence",
            title: `Send the saved reply to PayPal for ${c.buyer} on ${on}`,
            paypal: {
              method: "POST",
              path: `${base}/provide-evidence`,
              body: { evidences: [{ evidence_type: "OTHER", notes: text }] },
            },
            desk: {
              method: "POST",
              path: `${cp}/evidence`,
              body: { confirm: true, text },
            },
          });
        }
        // the seller sees the card and its case together
        if (staged.length > staged0) ui.push({ type: "select_case", id: c.id });
        break;
      }
    }
  }
  return {
    ui,
    staged,
    remember,
    ...(ambiguous ? { ambiguous } : {}),
    ...(already ? { already } : {}),
  };
}

// same words as the list's dueWords in web/src/lib/format.ts
const dueWords = (d: number | null | undefined) =>
  d == null
    ? "soon"
    : d < 0
      ? "overdue"
      : d === 0
        ? "today"
        : d === 1
          ? "tomorrow"
          : `in ${d} days`;
/** Calendar days to the due time in the seller's timezone (offset as Date.getTimezoneOffset): the list's dayDiff. */
export const calendarDays = (
  iso: string,
  tzOffsetMin = 0,
  now = Date.now(),
) => {
  const day = (t: number) => Math.floor((t - tzOffsetMin * 60000) / 86400000);
  return day(Date.parse(iso)) - day(now);
};
/** The list's DUE THIS WEEK group: open and due within 7 calendar days (overdue included). */
export const dueThisWeek = (cases: ListedCase[]) =>
  sortCases(cases).filter(
    (c) => isOpen(c) && c.due_in_days != null && c.due_in_days <= 7,
  );
const listLine = (c: ListedCase) =>
  `${[c.item, c.buyer].filter(Boolean).join(" · ")} · ${money(c.amount_cents, c.currency)} · due ${dueWords(c.due_in_days)}`;
const sortCases = (cases: ListedCase[]) =>
  [...cases].sort(
    (a, b) =>
      Number(a.status_group === "waiting") -
        Number(b.status_group === "waiting") ||
      (a.due_in_days ?? Infinity) - (b.due_in_days ?? Infinity),
  );

/** Answers that need no model: the desk already decided. */
function deterministic(
  text: string,
  all: ListedCase[],
): {
  reply: string;
  raw: unknown[];
  list?: { id: string; line: string }[];
} | null {
  const t = text.toLowerCase();
  const open = sortCases(all).filter(isOpen);
  const words = (c: ListedCase) =>
    callWords(c.call, c.offer_cents ?? undefined, c.currency);
  if (/first|most urgent|priorit|start with/.test(t) && open[0]) {
    const [a, b] = open;
    return {
      reply:
        `Start with ${caseLabel(a!)}. It's due ${dueWords(a!.due_in_days)}, and the desk's call is ${words(a!)}.` +
        (b
          ? ` Next up is ${caseLabel(b)}, due ${dueWords(b.due_in_days)}.`
          : ""),
      raw: [{ type: "select_case", id: a!.id }],
    };
  }
  if (/due (this|next) week|this week/.test(t)) {
    const hit = dueThisWeek(all);
    if (!hit.length) return { reply: "Nothing is due this week.", raw: [] };
    return {
      reply: `${hit.length} ${hit.length === 1 ? "dispute is" : "disputes are"} due this week:`,
      raw: [
        { type: "filter", ids: hit.map((c) => c.id) },
        { type: "select_case", id: hit[0]!.id },
      ],
      list: hit.map((c) => ({ id: c.id, line: listLine(c) })),
    };
  }
  if (/^\s*send the offer\b/.test(t))
    return {
      reply: "Here is the offer, ready for your OK.",
      raw: [{ type: "make_dispute_offer" }],
    };
  const kind = /which\b[^.?]*\brefund|just refund/.test(t)
    ? (["accept", "Refund these", "in full"] as const)
    : /which\b[^.?]*\boffer/.test(t)
      ? (["offer", "Make an offer on these", ""] as const)
      : /which\b[^.?]*\bfight/.test(t)
        ? (["fight", "Fight these", ""] as const)
        : null;
  if (!kind) return null;
  const hit = open.filter((c) => c.call === kind[0]);
  if (!hit.length)
    return {
      reply: "None of your open cases has that call right now.",
      raw: [],
    };
  const far = hit.filter((c) => (c.due_in_days ?? 0) > 14).length;
  return {
    reply: `${kind[1]} ${hit.length}${kind[2] ? " " + kind[2] : ""}:${far ? ` (${far} of them ${far === 1 ? "is" : "are"} more than 14 days out)` : ""}`,
    raw: [
      { type: "filter", ids: hit.map((c) => c.id) },
      { type: "select_case", id: hit[0]!.id },
    ],
    list: hit.map((c) => ({ id: c.id, line: listLine(c) })),
  };
}

const SYSTEM = `You are Parley, a calm, dry snowy-owl dispute advisor for a PayPal seller. Keep answers to one to three short sentences. Name a case by item, buyer and amount, like \"Ember 20F Sleeping Bag · Marcus Bell · $179.00\", and never write its PP-D id in the reply (ids belong only in actions). Never invent money: every number comes from the case facts below. A "call" of accept means refund or accept the claim; fight means send evidence.
Reply ONLY with JSON: {"reply": "...", "actions": [...]}. Allowed actions:
{"type":"select_case","id":"<case id>"}, {"type":"open_tab","tab":"overview|evidence|buyer|timeline|draft|math"}, {"type":"filter","ids":["<case id>"]} (ids null clears), {"type":"highlight_evidence"}, {"type":"remember","fact":"..."},
{"type":"make_dispute_offer","case_id":"..","amount_cents":<int>,"offer_type":"REFUND"}, {"type":"provide_dispute_evidence","case_id":".."}, {"type":"accept_dispute_claim","case_id":".."}, {"type":"get_dispute","case_id":".."}, {"type":"list_disputes"}.
The make_dispute_offer, provide_dispute_evidence and accept_dispute_claim actions only propose a card; the seller must approve it. get_dispute and list_disputes just read. Use no action when none is needed. When asked which disputes to refund or offer on, answer in the reply and send a filter action with those case ids. When asked to send an offer, send make_dispute_offer for that case (find it by item or buyer in the case list).
The call on each case is the desk's decision: quote it, never contradict it. A remembered seller rule applies only when every condition in it matches the case ("under $50" does not match $100). If a rule conflicts with the desk's call, give the desk's call and mention the rule.`;

/** What Parley says when the AI call fails. */
export const busyReply = (ctx: CaseCtx | null): string =>
  ctx
    ? `Parley's AI is busy right now. Here is the desk's call for this case: ${callWords(ctx.call, ctx.offer_cents, ctx.currency)}.`
    : "Parley's AI is busy right now. Open a case and I can give you the desk's call.";

const ensure = new WeakSet<object>();
async function init(db: Db): Promise<void> {
  if (ensure.has(db)) return;
  await db.query(`create table if not exists conversations (
    id bigserial primary key, title text, case_id text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  await db.query(`create table if not exists messages (
    id bigserial primary key, conversation_id bigint not null references conversations(id) on delete cascade,
    role text not null check (role in ('user','parley')), text text not null,
    actions jsonb, at timestamptz not null default now())`);
  await db.query(`create table if not exists memory (
    id bigserial primary key, fact text not null, created_at timestamptz not null default now())`);
  ensure.add(db);
}

async function readBody(req: unknown): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  try {
    const t = Buffer.concat(chunks).toString("utf8");
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

const bad = (detail: string) => ({
  status: 400,
  body: { error: "bad_request", detail },
});

export async function chatRoutes(
  req: { method?: string } & AsyncIterable<Buffer>,
  url: URL,
  deps: ChatDeps,
): Promise<{ status: number; body: unknown } | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/chat/")) return null;
  const m = req.method ?? "GET";
  const db = deps.pool;
  await init(db);

  if (p === "/api/chat/conversations" && m === "GET") {
    const r = await db.query(
      `select id::text, title, case_id, created_at, updated_at from conversations order by updated_at desc, id desc limit 50`,
    );
    return { status: 200, body: { conversations: r.rows } };
  }
  if (p === "/api/chat/conversations" && m === "POST") {
    const b = await readBody(req);
    const r = await db.query(
      `insert into conversations(title, case_id) values ('New chat', $1) returning id::text, title, case_id, created_at, updated_at`,
      [typeof b["case_id"] === "string" ? b["case_id"] : null],
    );
    return { status: 201, body: { conversation: r.rows[0] } };
  }
  const c = /^\/api\/chat\/conversations\/(\d+)(\/messages)?$/.exec(p);
  if (c) {
    const cid = c[1]!;
    const conv = (
      await db.query(
        `select id::text, title, case_id, created_at, updated_at from conversations where id = $1`,
        [cid],
      )
    ).rows[0];
    if (!conv)
      return {
        status: 404,
        body: { error: "not_found", detail: "no such conversation" },
      };
    if (!c[2] && m === "GET") {
      const r = await db.query(
        `select id::text, role, text, actions, at from messages where conversation_id = $1 order by id`,
        [cid],
      );
      return { status: 200, body: { conversation: conv, messages: r.rows } };
    }
    if (c[2] && m === "POST")
      return postMessage(db, deps, cid, conv, await readBody(req));
  }
  if (p === "/api/chat/memory" && m === "GET") {
    const r = await db.query(
      `select id::text, fact, created_at from memory order by id`,
    );
    return { status: 200, body: { memory: r.rows } };
  }
  const mem = /^\/api\/chat\/memory\/(\d+)$/.exec(p);
  if (mem && m === "DELETE") {
    await db.query(`delete from memory where id = $1`, [mem[1]]);
    return { status: 200, body: { deleted: true } };
  }
  const st = /^\/api\/chat\/staged\/([0-9a-f-]{36})\/approved$/.exec(p);
  if (st && m === "POST") {
    const b = await readBody(req);
    if (typeof b["ok"] !== "boolean") return bad("ok must be true or false");
    const r = await db.query(
      `select conversation_id::text as cid, actions from messages where actions @> $1::jsonb limit 1`,
      [JSON.stringify({ staged: [{ id: st[1] }] })],
    );
    if (!r.rows[0])
      return {
        status: 404,
        body: { error: "not_found", detail: "no such staged card" },
      };
    const title =
      (r.rows[0].actions.staged as Staged[]).find((s) => s.id === st[1])
        ?.title ?? "action";
    const detail =
      typeof b["result"] === "string" && b["result"]
        ? `. ${b["result"].slice(0, 200)}`
        : "";
    const text = b["ok"]
      ? `Sent to PayPal: ${title}${detail}`
      : `Not sent: ${title}${detail}`;
    await db.query(
      `insert into messages(conversation_id, role, text) values ($1,'parley',$2)`,
      [r.rows[0].cid, text],
    );
    await db.query(
      `update conversations set updated_at = now() where id = $1`,
      [r.rows[0].cid],
    );
    return { status: 200, body: { logged: true } };
  }
  return { status: 404, body: { error: "not_found", detail: p } };
}

async function postMessage(
  db: Db,
  deps: ChatDeps,
  cid: string,
  conv: { title: string | null; case_id: string | null },
  b: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const text = typeof b["text"] === "string" ? b["text"].trim() : "";
  if (!text || text.length > 2000)
    return bad("text must be 1 to 2000 characters");
  const caseId =
    typeof b["case_id"] === "string" && b["case_id"]
      ? b["case_id"]
      : (conv.case_id ?? undefined);
  const ctx = caseId ? await deps.loadCase(caseId) : null;
  const tz = typeof b["tz_offset"] === "number" ? b["tz_offset"] : 0;
  // whole calendar days in the seller's timezone, as the list counts them
  const base = deps.listCases;
  deps = {
    ...deps,
    listCases: async () =>
      (await base()).map((c) =>
        c.due_at ? { ...c, due_in_days: calendarDays(c.due_at, tz) } : c,
      ),
  };

  await db.query(
    `insert into messages(conversation_id, role, text) values ($1,'user',$2)`,
    [cid, text],
  );
  if (!conv.title || conv.title === "New chat")
    await db.query(`update conversations set title = $2 where id = $1`, [
      cid,
      text.slice(0, 40),
    ]);

  let reply = "";
  let raw: unknown[] = [];
  let list: { id: string; line: string }[] | undefined;
  let det: ReturnType<typeof deterministic>;
  const rem = /^\s*remember\b[\s,:]*(?:that\s+)?(.+)$/is.exec(text);
  if (rem) {
    raw = [{ type: "remember", fact: rem[1] }];
    reply = "Noted. I will keep that in mind.";
  } else if ((det = deterministic(text, await deps.listCases()))) {
    ({ reply, raw, list } = det);
  } else {
    const hist = (
      await db.query(
        `select role, text from messages where conversation_id = $1 order by id desc limit 12`,
        [cid],
      )
    ).rows.reverse();
    const facts = (
      await db.query(`select fact from memory order by id`)
    ).rows.map((r) => r.fact as string);
    const cases = await deps.listCases();
    const context = [
      facts.length
        ? `What you know about the seller:\n- ${facts.join("\n- ")}`
        : "",
      `Cases:\n${
        sortCases(cases)
          .map(
            (x) =>
              `id=${x.id} label="${caseLabel(x)}" reason="${reasonWords(x.reason)}" due="${dueWords(x.due_in_days)}" group=${x.status_group ?? "needs_you"} call="${callWords(x.call, x.offer_cents ?? undefined, x.currency)}"${typeof x.p === "number" ? ` win=${Math.round(x.p * 100)}%` : ""}`,
          )
          .join("\n") || "none"
      }`,
      ctx
        ? `Open case ${ctx.id}: ${ctx.buyer}${ctx.item ? ` (${ctx.item})` : ""}, ${money(ctx.amount_cents, ctx.currency)}, reason ${ctx.reason}, call ${ctx.call ?? "unknown"}` +
          (ctx.p !== undefined
            ? `, win chance ${Math.round(ctx.p * 100)}%`
            : "") +
          (ctx.interval
            ? ` (range ${Math.round(ctx.interval[0] * 100)}-${Math.round(ctx.interval[1] * 100)}%)`
            : "") +
          (ctx.offer_cents !== undefined
            ? `, offer ${money(ctx.offer_cents, ctx.currency)}`
            : "") +
          (ctx.keep_cents !== undefined
            ? `, keep ${money(ctx.keep_cents, ctx.currency)}`
            : "") +
          (ctx.missing_evidence?.length
            ? `, missing evidence: ${ctx.missing_evidence.join(", ")}`
            : "")
        : "No case is open.",
    ]
      .filter(Boolean)
      .join("\n");
    const res = await deps.llm.complete<string>(
      {
        system: `${SYSTEM}\n\n${context}`,
        messages: hist.map((h) => ({
          role: h.role === "user" ? ("user" as const) : ("assistant" as const),
          content: h.text as string,
        })),
        maxTokens: 500,
        temperature: 0.3,
      },
      () => "",
    );
    if (
      res.source === "llm" &&
      typeof res.value === "string" &&
      res.value.trim()
    ) {
      const parsed = parseReply(res.value);
      reply = labelIds(parsed.reply, cases);
      raw = parsed.actions;
    } else {
      reply = busyReply(ctx);
    }
  }
  const { ui, staged, remember, ambiguous, already } = await validateActions(
    raw,
    deps,
    caseId,
    text,
  );
  if (already) reply = already;
  if (ambiguous) {
    const all = await deps.listCases();
    reply = "Which one do you mean?";
    list = ambiguous.map((id) => {
      const c = all.find((x) => x.id === id)!;
      return {
        id,
        line: `${c.item ?? c.buyer} · ${c.item ? c.buyer + " · " : ""}${reasonWords(c.reason)} · ${money(c.amount_cents, c.currency)} · due ${dueWords(c.due_in_days)}`,
      };
    });
  }
  for (const f of remember)
    await db.query(`insert into memory(fact) values ($1)`, [f]);
  const saved = (
    await db.query(
      `insert into messages(conversation_id, role, text, actions) values ($1,'parley',$2,$3) returning id::text, role, text, actions, at`,
      [
        cid,
        reply || "Done.",
        JSON.stringify({ ui, staged, ...(list ? { list } : {}) }),
      ],
    )
  ).rows[0];
  await db.query(`update conversations set updated_at = now() where id = $1`, [
    cid,
  ]);
  return {
    status: 200,
    body: {
      message: saved,
      ui_actions: ui,
      staged,
      remembered: remember,
      ...(list ? { list } : {}),
    },
  };
}

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const fmts = new Map();
// amounts always carry their own currency; whole amounts may drop the cents
const money = (cents, cur = "USD", whole = false) => {
  whole = whole && cents % 100 === 0;
  const k = cur + whole;
  if (!fmts.has(k))
    fmts.set(
      k,
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: cur,
        ...(whole ? { minimumFractionDigits: 0 } : {}),
      }),
    );
  const v = Math.abs(cents) / 100;
  return fmts.get(k).format(v);
};
const signed = (cents, cur) => (cents < 0 ? "-" : "") + money(cents, cur);
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok)
    throw Object.assign(new Error(String(r.status)), {
      status: r.status,
      body,
    });
  return body;
};
const post = (path, data) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });

const DAY = 86400000;
const REASONS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorised",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  CREDIT_NOT_PROCESSED: "Refund not processed",
  CANCELED_RECURRING_BILLING: "Cancelled subscription",
};
const sentence = (s) => {
  const t = String(s ?? "")
    .replaceAll("_", " ")
    .toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const reasonWords = (r) => REASONS[r] ?? sentence(r);
const needsResponse = (c) =>
  c.status === "WAITING_FOR_SELLER_RESPONSE" || c.status === "OPEN";
const statusWords = (c) => {
  if (needsResponse(c)) return "Needs your response";
  if (c.status === "WAITING_FOR_BUYER_RESPONSE") return "Waiting for buyer";
  if (c.status === "UNDER_REVIEW") return "Under review";
  if (c.status === "RESOLVED" || c.outcome)
    return c.outcome === "RESOLVED_SELLER_FAVOUR"
      ? "Resolved: you won"
      : c.outcome === "RESOLVED_BUYER_FAVOUR"
        ? "Resolved: buyer won"
        : "Resolved";
  return sentence(c.status);
};
// call may be "accept (marginal)"; marginal is also a flag on the decision
function rec(call, marginal) {
  if (!call)
    return {
      kind: "unknown",
      base: null,
      label: "Analysing…",
      color: "grey",
    };
  const base = call.startsWith("fight") ? "fight" : "accept";
  const m = marginal ?? call.includes("marginal");
  if (m)
    return {
      kind: "marginal",
      base,
      label: `Close call: ${base}`,
      color: "amber",
    };
  return {
    kind: base,
    base,
    label: base === "fight" ? "Fight" : "Accept",
    color: base === "fight" ? "green" : "red",
  };
}
const dateShort = (iso) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const dateLong = (iso) =>
  new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
const inDays = (iso) => {
  const d = (Date.parse(iso) - Date.now()) / DAY;
  if (d < 0) return "overdue";
  const n = Math.ceil(d);
  return `in ${n} day${n === 1 ? "" : "s"}`;
};

let gridApi;
let allCases = [];
let current = null;
let currentAnalysis = null;
let added = new Map(); // checklist item -> evidence held until submit
let fightAnyway = false;
let sent = null; // success message once a write went through
let sentText = null; // the response text that went to PayPal
let summary = null;
let pending = null; // action waiting on the in-page confirm

const columns = [
  { field: "buyer", headerName: "Buyer", flex: 1, minWidth: 130 },
  {
    headerName: "Reason",
    flex: 1.2,
    minWidth: 160,
    valueGetter: (p) => reasonWords(p.data.reason),
  },
  {
    field: "amount_cents",
    headerName: "Amount",
    width: 120,
    valueFormatter: (p) => money(p.value, p.data.currency),
  },
  {
    field: "due_at",
    headerName: "Due",
    width: 100,
    sort: "asc",
    comparator: (a, b, _x, _y, desc) =>
      a == null
        ? b == null
          ? 0
          : desc
            ? -1
            : 1
        : b == null
          ? desc
            ? 1
            : -1
          : Date.parse(a) - Date.parse(b),
    valueFormatter: (p) => (p.value ? dateShort(p.value) : ""),
  },
  {
    headerName: "Recommendation",
    width: 170,
    valueGetter: (p) =>
      p.data.call || needsResponse(p.data) ? rec(p.data.call).label : "—",
    cellClass: (p) => "cell-" + rec(p.data.call).kind,
  },
  {
    headerName: "Status",
    flex: 1,
    minWidth: 160,
    valueGetter: (p) => statusWords(p.data),
  },
  { field: "dispute_id", headerName: "Case id", width: 160, hide: true }, // kept for search
];

function setupGrid() {
  gridApi = agGrid.createGrid($("grid"), {
    columnDefs: columns,
    rowData: [],
    getRowId: (p) => p.data.dispute_id,
    rowSelection: {
      mode: "singleRow",
      checkboxes: false,
      enableClickSelection: true,
    },
    onRowClicked: (e) => openCase(e.data.dispute_id),
    defaultColDef: { sortable: true, resizable: true, filter: true },
    includeHiddenColumnsInQuickFilter: true,
    suppressNoRowsOverlay: true,
    rowHeight: GRID_ROW,
    headerHeight: GRID_ROW,
    onModelUpdated: fitGrid,
  });
}
const GRID_ROW = 36;
// height follows the rows, up to 15
function fitGrid() {
  const shown = gridApi.getDisplayedRowCount();
  $("nomatch").hidden = shown > 0 || !allCases.length;
  const n = Math.min(15, Math.max(1, shown));
  $("grid").style.height = `${(n + 1) * GRID_ROW + 4}px`;
}

async function loadCases() {
  const r = await api("/api/cases");
  allCases = r.cases;
  summary = r.summary ?? null;
  gridApi.setGridOption("rowData", allCases);
  const sm = summary;
  $("all-sum").textContent = sm
    ? `All cases (${sm.total}): ${sm.needs_response} need a response, ${sm.under_review} under review, ${sm.closed} closed`
    : `All cases (${allCases.length})`;
  renderSituation();
  renderCards();
  renderMissed();
  renderTimeline(allCases);
  if (!retried && needing().some((c) => !c.call)) {
    retried = true;
    setTimeout(() => loadCases().catch(() => {}), 5000);
  }
}
let retried = false;

const byDue = (a, b) =>
  (Date.parse(a.due_at) || Infinity) - (Date.parse(b.due_at) || Infinity);
const missedDeadline = (c) =>
  needsResponse(c) && c.due_at && Date.parse(c.due_at) < Date.now();
const needing = () =>
  allCases.filter((c) => needsResponse(c) && !missedDeadline(c)).sort(byDue);
const missedList = () => allCases.filter(missedDeadline).sort(byDue);
const dueSoon = (c) =>
  !!c.due_at && Math.ceil((Date.parse(c.due_at) - Date.now()) / DAY) <= 3;
const orderText = (c) => {
  const it = c.items?.length
    ? c.items
    : c.item
      ? [{ item_description: c.item, item_quantity: c.item_quantity ?? 1 }]
      : [];
  const f = (i) => `${i.item_quantity} × ${i.item_description}`;
  return it.length > 2
    ? `${f(it[0])} + ${it.length - 1} more`
    : it.map(f).join(" + ");
};
const buyerOpen = (name) => needing().filter((c) => c.buyer === name).length;

function renderSituation() {
  const n = needing();
  const soon = n.filter(dueSoon).length;
  const sm = summary;
  const cur = sm?.currency ?? "USD";
  const stake =
    sm?.at_stake_cents ??
    n.filter((c) => c.currency === cur).reduce((t, c) => t + c.amount_cents, 0);
  const f = n.filter((c) => rec(c.call).base === "fight").length;
  const a = n.filter((c) => rec(c.call).base === "accept").length;
  const need = sm?.needs_response ?? n.length;
  $("situation").textContent =
    `${sm ? `${sm.total} disputes this month: ` : ""}${need} need${sm || need !== 1 ? "" : "s"} your response · ${soon} due in the next 3 days · ${money(stake, cur)} at stake · Recommended: fight ${f}, accept ${a}`;
  $("holds").hidden = !stake;
  $("holds").textContent =
    `PayPal holds ${money(stake, cur)} of your payouts until these are settled.`;
  $("start").disabled = !n.length;
}

let showAll = false;
function renderCards() {
  const n = needing();
  const shown = showAll ? n : n.slice(0, 6);
  $("cards").innerHTML =
    shown
      .map((c) => {
        const r = rec(c.call);
        const due = c.due_at
          ? `Due ${dateLong(c.due_at)} · ${inDays(c.due_at)}`
          : "No due date";
        const ot = orderText(c);
        const item = ot ? `<span class="reason">${esc(ot)}</span>` : "";
        const rb = buyerOpen(c.buyer);
        const tag =
          rb >= 2 ? `<span class="pill amber">${rb} disputes from this buyer</span>` : "";
        return `<div class="dcard" tabindex="0" role="button" data-id="${esc(c.dispute_id)}"><span class="who">${esc(c.buyer)}</span><span class="reason">${esc(reasonWords(c.reason))}</span>${item}<span class="amt">${money(c.amount_cents, c.currency)}</span><span class="due${dueSoon(c) ? " soon" : ""}">${esc(due)}</span><span class="pill ${r.color}">${r.label}</span>${tag}</div>`;
      })
      .join("") ||
    '<p class="muted">Nothing needs your response right now.</p>';
  for (const el of $("cards").querySelectorAll(".dcard")) {
    el.onclick = () => openCase(el.dataset.id);
    el.onkeydown = (e) =>
      (e.key === "Enter" || e.key === " ") &&
      (e.preventDefault(), openCase(el.dataset.id));
  }
  const more = $("show-all");
  more.hidden = n.length <= 6;
  more.textContent = showAll ? "Show fewer" : `Show all ${n.length}`;
}

function renderMissed() {
  const m = missedList();
  const el = $("missed");
  el.hidden = !m.length;
  if (!m.length) return (el.innerHTML = "");
  el.innerHTML = `<details class="missed"><summary>Missed deadline (${m.length})</summary>${m.map((c) => `<div class="m" data-id="${esc(c.dispute_id)}">${esc(c.buyer)} · ${money(c.amount_cents, c.currency)} · was due ${dateShort(c.due_at)}</div>`).join("")}</details>`;
  for (const x of el.querySelectorAll(".m"))
    x.onclick = () => openCase(x.dataset.id);
}

function renderTimeline(cases) {
  const el = $("timeline");
  el.innerHTML = '<div class="axis"></div>';
  const now = Date.now();
  const span = 21 * DAY;
  for (let d = 0; d <= 21; d += d < 7 ? 1 : 7) {
    const t = document.createElement("div");
    t.className = "tick" + (d % 7 === 0 ? " week" : "");
    t.style.left = `${(d / 21) * 96 + 2}%`;
    t.textContent = d === 0 ? "now" : `+${d}d`;
    el.appendChild(t);
  }
  const lanes = new Map();
  const open = cases.filter(
    (c) => needsResponse(c) && c.due_at && Date.parse(c.due_at) - now <= span,
  );
  for (const c of open.sort(
    (a, b) => Date.parse(a.due_at) - Date.parse(b.due_at),
  )) {
    const left =
      Math.min(1, Math.max(0, (Date.parse(c.due_at) - now) / span)) * 96 + 2;
    const bucket = Math.round(left);
    const lane = lanes.get(bucket) ?? 0;
    lanes.set(bucket, lane + 1);
    const r = rec(c.call);
    const m = document.createElement("div");
    m.className = `marker ${r.kind}${dueSoon(c) ? " soon" : ""}`;
    m.style.left = `${left}%`;
    m.style.top = `${40 - (lane % 3) * 14}px`;
    m.title = `${c.buyer} · ${money(c.amount_cents, c.currency)} · due ${dateShort(c.due_at)} · ${r.label}`;
    m.onclick = () => openCase(c.dispute_id);
    el.appendChild(m);
  }
}

// the hash drives opening, so back/forward and reload work
function openCase(id) {
  if (location.hash === `#case=${encodeURIComponent(id)}`) return loadCase(id);
  location.hash = `case=${encodeURIComponent(id)}`;
}
function closeCase() {
  $("panel").hidden = true;
  current = null;
  hideConfirm();
  if (location.hash)
    history.pushState(null, "", location.pathname + location.search);
}
const hashId = () => {
  const m = /^#case=(.+)$/.exec(location.hash);
  try {
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
};
function onHash() {
  const id = hashId();
  if (id && id !== current) loadCase(id);
  else if (!id && current) {
    $("panel").hidden = true;
    current = null;
    hideConfirm();
  }
}

async function loadCase(id) {
  current = id;
  added = new Map();
  fightAnyway = false;
  sent = null;
  sentText = null;
  drafting = false;
  draftSeq++;
  $("draft-note").hidden = true;
  $("draft").classList.remove("dim");
  hideConfirm();
  $("panel").hidden = false;
  $("panel-title").textContent = "Loading...";
  $("panel-sub").textContent = "";
  $("action-result").innerHTML = "";
  $("in-prior").value = "";
  $("in-c").value = "15.00";
  $("in-fee").value = "0.00";
  $("draft").value = "";
  await recompute(true);
  $("panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function recompute(fresh) {
  if (!current) return;
  const q = new URLSearchParams();
  const p = $("in-prior").value.trim();
  if (p !== "") {
    const v = Number(p);
    if (!(v >= 0 && v <= 100)) {
      $("panel-error").hidden = false;
      $("panel-error").textContent = "Win chance must be between 0 and 100.";
      return;
    }
    q.set("prior", String(v / 100));
  }
  q.set("c", $("in-c").value || "15");
  q.set("fee", $("in-fee").value || "0");
  try {
    currentAnalysis = await api(
      `/api/cases/${encodeURIComponent(current)}/analysis?${q}`,
    );
    $("panel-error").hidden = true;
  } catch {
    $("panel-error").hidden = false;
    $("panel-error").textContent = "Could not load this case. Try again.";
    return;
  }
  renderAnalysis(currentAnalysis, fresh);
}

const setAi = (on) => {
  const el = $("ai-pill");
  el.hidden = false;
  el.textContent = on ? "AI drafting on" : "AI offline: template drafts";
  el.className = "pill " + (on ? "green" : "grey");
};
const pct = (x) => Math.round(x * 100);
function recSentence(d, c, cost) {
  const cur = c.currency;
  const A = c.amount_cents;
  const cc = money(cost * 100, cur, true);
  const basis = d.n > 0 ? ` (based on ${d.n} similar past case${d.n === 1 ? "" : "s"})` : "";
  if (d.call === "fight")
    return `You have a ${pct(d.p)}% chance of keeping ${money(A, cur)}${basis}. Fighting costs about ${cc}; if you lose, you refund what you would refund anyway.`;
  return `Only a ${pct(d.p)}% chance of keeping ${money(A, cur)}${basis}, so fighting (about ${cc}) is unlikely to pay off. Refund it and close the case.`;
}
const unbracket = (t) => String(t ?? "").replace(/[[\]]/g, "");
// seller messages may join several points with "; "
const lines = (t) =>
  String(t ?? "")
    .split("; ")
    .filter(Boolean);

function renderAnalysis(a, fresh) {
  const c = a.case;
  const amt = money(c.amount_cents, c.currency);
  $("panel-title").textContent =
    `${c.buyer} · ${reasonWords(c.reason)} · ${amt}`;
  const upd = Date.parse(c.updated_at);
  const rb = needsResponse(c) ? buyerOpen(c.buyer) : 0;
  const status =
    c.status === "UNDER_REVIEW" && upd
      ? `Response sent ${dateShort(upd)} · PayPal usually decides by about ${dateShort(upd + 30 * DAY)}`
      : c.status === "RESOLVED" || c.outcome
        ? `Closed ${upd ? dateShort(upd) : ""} · ${c.outcome === "RESOLVED_SELLER_FAVOUR" ? "Decided for you" : c.outcome === "RESOLVED_BUYER_FAVOUR" ? "Decided for the buyer" : "Resolved"}`
        : c.due_at
          ? `Response due ${dateShort(c.due_at)} (${inDays(c.due_at)}) · ${statusWords(c)}`
          : statusWords(c);
  $("panel-sub").textContent = status;
  $("repeat").hidden = rb < 2;
  $("repeat").textContent = `${c.buyer} has ${rb} open disputes with you, a pattern PayPal reviewers look at.`;
  $("caseref").textContent = `Case reference: ${c.dispute_id}`;
  const draftText = (a.draft?.response ?? "").trim();
  const isSellerText = (n) =>
    n &&
    (n.trim() === draftText ||
      c.messages.some(
        (m) => m.posted_by !== "BUYER" && m.content.includes(n.trim()),
      ));
  const evs = c.evidences.filter(
    (e) => !(e.evidence_type === "OTHER" && isSellerText(e.notes)),
  );
  const hidden = c.evidences.find(
    (e) => e.evidence_type === "OTHER" && isSellerText(e.notes),
  );
  $("messages").innerHTML =
    c.messages
      .map((m) =>
        m.posted_by === "BUYER"
          ? `<div class="msg"><b>Buyer</b>: ${esc(m.content)}</div>`
          : lines(m.content)
              .map(
                (l, i) =>
                  `<div class="msg">${i ? "" : "<b>You</b>: "}${esc(l)}</div>`,
              )
              .join(""),
      )
      .join("") || '<p class="muted">No messages.</p>';
  $("items").innerHTML =
    c.items
      .map(
        (i) =>
          `<div class="msg">${esc(i.item_quantity)} × ${esc(i.item_description)}</div>`,
      )
      .join("") || '<p class="muted">No items listed.</p>';
  $("evidence").innerHTML =
    evs
      .map((e) => {
        const t = (e.evidence_info?.tracking_info ?? [])
          .map((x) => `${x.carrier_name} ${x.tracking_number}`)
          .join(", ");
        return `<div class="msg">${t ? `<b>${esc(t)}</b> ` : ""}${esc(e.notes ?? "")}</div>`;
      })
      .join("") || '<p class="muted">Nothing yet</p>';
  onFile = evs.length;
  const shownText = sentText ?? (hidden ? hidden.notes : null);
  $("sent-block").hidden = !shownText;
  $("sent-block").innerHTML = shownText
    ? `<h3>Your response</h3><div class="sent">${esc(shownText)}</div>`
    : "";

  const d = a.decision;
  const r = d ? rec(d.call, d.marginal) : null;
  const box = $("rec");
  if (d) {
    const cost = Number($("in-c").value) || 15;
    box.className = `rec ${r.kind}`;
    box.innerHTML = `<div class="word">${d.marginal ? `Close call: ${d.call}` : d.call === "fight" ? "Fight" : "Accept"}</div><div>${esc(recSentence(d, c, cost))}</div>`;
    $("terms").textContent = d.terms.join("\n");
    const cur = c.currency;
    const rows = [
      ["Win chance", `${pct(d.p)}%`],
      ["Amount at stake", money(c.amount_cents, cur)],
      ["Cost to fight", money(cost * 100, cur)],
      ["Expected value of fighting", signed(d.ev_fight_cents, cur)],
      ["Expected value of refunding", signed(d.ev_accept_cents, cur)],
    ];
    $("terms-list").innerHTML = rows
      .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`)
      .join("");
    $("p0line").textContent =
      `Starting estimate for this kind of dispute: ${pct(d.p0)}% (an assumption, not PayPal data)`;
  } else {
    box.className = "rec";
    box.innerHTML =
      '<div class="muted">No recommendation is available right now. You can still respond below.</div>';
    $("terms").textContent = "";
    $("terms-list").innerHTML = "";
    $("p0line").textContent = "";
  }
  $("precedents").innerHTML = a.precedents.length
    ? `<table class="prec"><tr><th>Outcome</th><th>Snippet</th></tr>${a.precedents.map((p) => `<tr><td>${p.won ? "You won" : "Buyer won"}</td><td>${esc(unbracket(p.snippet))}</td></tr>`).join("")}</table>`
    : '<p class="muted">No similar resolved cases yet.</p>';

  const dr = a.draft;
  if (fresh || !$("draft").value) $("draft").value = dr.response;
  const b = $("badge");
  const ai = dr.source === "llm";
  b.textContent = ai ? "AI draft" : "Template draft";
  b.className = "pill " + (ai ? "green" : "grey");
  if (ai) setAi(true);
  $("explanation").textContent = dr.explanation ?? "";
  renderChecklist();
  renderActions();
}
let onFile = 0;

const canAct = () =>
  currentAnalysis && needsResponse(currentAnalysis.case) && !sent;
const isFight = () =>
  !currentAnalysis.decision ||
  currentAnalysis.decision.call === "fight" ||
  fightAnyway;
const missing = () =>
  currentAnalysis.draft.checklist.filter((i) => i.status === "missing");
const stillMissing = () => missing().filter((i) => !added.has(i.item));

function renderChecklist() {
  const a = currentAnalysis;
  const list = a.draft.checklist;
  $("fightbox").hidden = !(isFight() && needsResponse(a.case));
  const miss = stillMissing().length;
  const k = list.length;
  const cc = $("check-count");
  if (!k) cc.hidden = true;
  else {
    cc.hidden = false;
    cc.textContent = miss
      ? `${miss} of ${k} items missing`
      : `All ${k} items ready`;
    cc.className = "pill " + (miss ? "red" : "green");
  }
  const ul = $("checklist");
  ul.innerHTML = "";
  for (const i of list) {
    const li = document.createElement("li");
    const ok = i.status !== "missing";
    const ad = added.get(i.item);
    li.className = ok || ad ? "ok" : "no";
    li.innerHTML = `<span class="ico">${ok || ad ? "✓" : "✗"}</span><b>${esc(i.item)}</b><span class="why">${ad ? "Added, will be sent with your response" : esc(i.why)}</span>`;
    if (ad) li.querySelector(".why").style.color = "var(--green)";
    if (ad) {
      const u = document.createElement("a");
      u.href = "#";
      u.textContent = "Undo";
      u.onclick = (e) => (
        e.preventDefault(),
        added.delete(i.item),
        renderChecklist(),
        renderActions(),
        redraft()
      );
      li.appendChild(u);
    } else if (!ok) {
      const sg = i.suggestion;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = sg ? sg.label : "Add";
      if (sg) {
        btn.className = "primary";
        btn.onclick = () => {
          added.set(i.item, {
            item: i.item,
            evidence_type: evType(i.item),
            notes: sg.note,
          });
          renderChecklist();
          renderActions();
          redraft();
        };
        const own = document.createElement("a");
        own.href = "#";
        own.textContent = "Write your own";
        own.onclick = (e) => (
          e.preventDefault(),
          btn.remove(),
          own.remove(),
          li.appendChild(addForm(i))
        );
        li.append(btn, own);
      } else {
        btn.onclick = () => (btn.remove(), li.appendChild(addForm(i)));
        li.appendChild(btn);
      }
    }
    ul.appendChild(li);
  }
}

const evType = (item) =>
  /tracking|delivery|fulfil/i.test(item) ? "PROOF_OF_FULFILLMENT" : "OTHER";
const MAX_FILE = 5 * 1024 * 1024;
const FILE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
};
const readFile = (f) =>
  new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
    fr.onerror = rej;
    fr.readAsDataURL(f);
  });

function addForm(i) {
  const form = document.createElement("form");
  const tracking = i.item === "Tracking number";
  form.innerHTML = tracking
    ? '<div class="row"><label>Carrier<input name="carrier" required></label><label>Tracking number<input name="number" required></label></div>'
    : `<label>Note<textarea name="note" rows="2" required placeholder="What happened, in your words"></textarea></label><label>File (optional, .png .jpg .pdf, up to 5 MB)<input type="file" name="file" accept=".png,.jpg,.jpeg,.pdf"></label>`;
  form.insertAdjacentHTML(
    "beforeend",
    '<div class="formerr" hidden></div><div class="row"><button class="primary">Save</button><button type="button" class="cancel">Cancel</button></div>',
  );
  form.querySelector(".cancel").onclick = renderChecklist;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector(".formerr");
    const f = new FormData(form);
    const type = evType(i.item);
    let ev;
    if (tracking) {
      const carrier = String(f.get("carrier")).trim(),
        number = String(f.get("number")).trim();
      ev = {
        item: i.item,
        evidence_type: type,
        notes: `${carrier} tracking ${number}`,
        tracking: { carrier, number },
      };
    } else {
      ev = {
        item: i.item,
        evidence_type: type,
        notes: String(f.get("note")).trim(),
      };
      const file = f.get("file");
      if (file && file.size) {
        const ext = file.name.split(".").pop().toLowerCase();
        const ct = FILE_TYPES[ext];
        if (!ct)
          return (
            (err.hidden = false),
            (err.textContent = "Use a .png, .jpg or .pdf file.")
          );
        if (file.size > MAX_FILE)
          return (
            (err.hidden = false),
            (err.textContent = "That file is over 5 MB.")
          );
        ev.file = {
          name: file.name,
          content_type: ct,
          data_base64: await readFile(file),
        };
      }
    }
    added.set(i.item, ev);
    renderChecklist();
    renderActions();
    redraft();
  };
  return form;
}

let drafting = false;
let draftSeq = 0;
async function redraft() {
  const id = current;
  const seq = ++draftSeq;
  const note = $("draft-note");
  drafting = true;
  note.hidden = false;
  note.className = "muted";
  note.textContent = "Rewriting the draft with your new evidence…";
  $("draft").classList.add("dim");
  renderActions();
  let res = null;
  try {
    res = (
      await post(`/api/cases/${encodeURIComponent(id)}/draft`, {
        added: [...added.values()].map((e) => ({ item: e.item, note: e.notes })),
      })
    ).draft;
  } catch {}
  if (seq !== draftSeq || id !== current) return;
  drafting = false;
  $("draft").classList.remove("dim");
  if (res?.response) {
    $("draft").value = res.response;
    const ai = res.source === "llm";
    const b = $("badge");
    b.textContent = ai ? "AI draft, updated with your evidence" : "Template draft";
    b.className = "pill " + (ai ? "green" : "grey");
    if (ai) setAi(true);
    note.hidden = true;
  } else {
    note.className = "formerr";
    note.textContent = "Could not update the draft; your evidence will still be sent.";
  }
  renderActions();
}

function renderActions() {
  const el = $("actions");
  el.innerHTML = "";
  if (!canAct()) return;
  const c = currentAnalysis.case;
  const amt = money(c.amount_cents, c.currency);
  const submit = document.createElement("button");
  submit.className = "primary";
  submit.textContent = "Submit response to PayPal";
  const left = stillMissing().length;
  submit.disabled = left > 0 || drafting;
  submit.onclick = () => act("evidence");
  const hint = document.createElement("span");
  hint.className = "muted";
  hint.textContent = drafting ? "Updating the draft…" : "Add the missing evidence to submit";
  hint.hidden = !left && !drafting;
  const accept = document.createElement("button");
  accept.textContent = `Accept and refund ${amt}`;
  accept.onclick = () => act("accept");
  if (isFight()) {
    accept.className =
      currentAnalysis.decision?.call === "accept" ? "primary" : "";
    el.append(submit, hint, accept);
  } else {
    accept.className = "primary";
    const fa = document.createElement("button");
    fa.textContent = "Fight anyway";
    fa.onclick = () => (
      (fightAnyway = true),
      renderChecklist(),
      renderActions()
    );
    el.append(accept, fa);
  }
}

function hideConfirm() {
  pending = null;
  $("confirm").hidden = true;
}
// asks inside the page; run() sends once the person agrees
function act(kind) {
  const c = currentAnalysis.case;
  const amt = money(c.amount_cents, c.currency);
  pending = kind;
  if (kind === "evidence") {
    const ready = currentAnalysis.draft.checklist.filter(
      (i) => i.status !== "missing",
    ).length;
    const n = Math.max(onFile, ready) + added.size;
    $("confirm-text").textContent =
      `Send your response and ${n} evidence item${n === 1 ? "" : "s"} to PayPal for the ${amt} dispute with ${c.buyer}?`;
    $("confirm-ok").textContent = "Send to PayPal";
  } else {
    $("confirm-text").textContent =
      `Refund ${amt} to ${c.buyer} and close the case?`;
    $("confirm-ok").textContent = "Refund";
  }
  $("confirm").hidden = false;
  $("confirm-ok").focus();
}

async function run(kind) {
  hideConfirm();
  const path = `/api/cases/${encodeURIComponent(current)}/${kind}`;
  let body;
  if (kind === "evidence") {
    const items = [...added.values()];
    const files = items.map((e) => e.file).filter(Boolean);
    const evidence = items.map(({ file, ...e }) => e);
    body = { confirm: true, text: $("draft").value };
    if (evidence.length) body.evidence = evidence;
    if (files.length) body.files = files;
  } else {
    body = { note: "Accepted by the seller from the desk", confirm: true };
  }
  try {
    await post(path, body);
  } catch {
    $("action-result").innerHTML =
      `<div class="errbox">${kind === "evidence" ? "PayPal did not accept the response. Try again." : "PayPal did not accept the refund. Try again."}</div>`;
    loadActivity();
    return;
  }
  const msg =
    kind === "evidence"
      ? "Sent to PayPal. The case is now under review — PayPal usually decides within 30 days."
      : "Refund sent. Case resolved in the buyer's favour.";
  if (kind === "evidence") sentText = body.text;
  loadActivity();
  await loadCases().catch(() => {});
  await recompute(true);
  sent = msg;
  $("action-result").innerHTML = `<div class="okbox">${esc(msg)}</div>`;
  renderChecklist();
  renderActions();
}

async function search(e) {
  e.preventDefault();
  const q = $("search").value.trim();
  if (!q) return ($("results").hidden = true);
  $("all").open = true;
  const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const byId = new Map(allCases.map((c) => [c.dispute_id, c]));
  $("results").hidden = false;
  $("results").innerHTML =
    `<div class="muted">${r.hits.length} past case${r.hits.length === 1 ? "" : "s"} found</div>` +
    r.hits
      .map((h) => {
        const c = byId.get(h.dispute_id);
        return `<div class="hit" data-id="${esc(h.dispute_id)}"><b>${esc(c?.buyer ?? "Case " + h.dispute_id)}</b> · ${money(h.amount_cents, h.currency)} · ${esc(statusWords(c ?? h))}<br>${esc(h.snippet).replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>")}</div>`;
      })
      .join("");
  for (const el of $("results").querySelectorAll(".hit"))
    el.onclick = () => openCase(el.dataset.id);
}

let lastCall = null; // `at` of the newest call seen
let calls = [];
const ago = (iso) => {
  const t = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return t < 60
    ? `${t} s ago`
    : t < 3600
      ? `${Math.round(t / 60)} min ago`
      : `${Math.round(t / 3600)} h ago`;
};
const shortPath = (p) => String(p).replace(/(\/disputes\/)[^/]+/, "$1…");
function renderActivity() {
  const x = calls[0];
  $("act-last").textContent = x
    ? `Last PayPal call: ${x.method} ${shortPath(x.path)} · ${x.status} · ${x.ms} ms · ${ago(x.at)}`
    : "PayPal calls: none yet";
  $("activity-list").innerHTML = calls
    .slice(0, 20)
    .map(
      (x) =>
        `<li>${esc(x.method)} ${esc(shortPath(x.path))} · <span class="${x.status < 400 ? "s-ok" : "s-bad"}">${esc(x.status)}</span> · ${esc(x.ms)} ms · ${ago(x.at)}</li>`,
    )
    .join("");
}
function dockPad() {
  document.body.style.paddingBottom = `${$("activity").offsetHeight + 16}px`;
}
async function loadActivity() {
  try {
    const r = await fetch("/api/paypal-activity");
    if (!r.ok) throw 0;
    calls = [...(await r.json()).calls].sort(
      (a, b) => Date.parse(b.at) - Date.parse(a.at),
    );
    const bar = $("activity");
    bar.hidden = false;
    const newest = calls[0]?.at ?? null;
    if (lastCall !== null && newest && newest !== lastCall) {
      bar.classList.add("flash");
      setTimeout(() => bar.classList.remove("flash"), 2000);
    }
    lastCall = newest ?? "";
    renderActivity();
    dockPad();
  } catch {
    $("activity").hidden = true;
    document.body.style.paddingBottom = "";
  }
}

function startUrgent() {
  const c = needing()[0]; // the first card shown
  if (c) openCase(c.dispute_id);
}

async function init() {
  setupGrid();
  $("search-form").onsubmit = (e) =>
    search(e).catch(() =>
      alert("Search is not available right now. Try again."),
    );
  $("search").oninput = (e) => {
    $("all").open = true;
    gridApi.setGridOption("quickFilterText", e.target.value);
    if (!e.target.value.trim()) $("results").hidden = true;
  };
  $("recompute").onclick = () => recompute(false);
  $("start").onclick = startUrgent;
  $("close-panel").onclick = closeCase;
  $("confirm-ok").onclick = () => run(pending);
  $("confirm-cancel").onclick = hideConfirm;
  $("confirm").onkeydown = (e) => e.key === "Escape" && hideConfirm();
  $("act-toggle").onclick = () => {
    const open = $("activity-list").hidden;
    $("activity-list").hidden = !open;
    $("act-toggle").setAttribute("aria-expanded", String(open));
    dockPad();
  };
  addEventListener("hashchange", onHash);
  addEventListener("resize", dockPad);
  $("show-all").onclick = (e) => (
    e.preventDefault(),
    (showAll = !showAll),
    renderCards()
  );
  $("sync").onclick = async () => {
    $("sync").disabled = true;
    try {
      await post("/api/sync", {});
      await loadCases();
    } catch {
      alert("Could not refresh from PayPal. Try again.");
    }
    $("sync").disabled = false;
  };
  const info = await api("/api/info").catch(() => null);
  if (info) {
    const env = { sandbox: "PayPal Sandbox", mock: "PayPal test data" }[
      info.paypalEnv
    ];
    $("env-pill").hidden = !env;
    $("env-pill").textContent = env ?? "";
    setAi(!!info.llm?.online);
    $("unreachable").hidden = !info.sync?.error;
  }
  await loadCases().catch(
    () =>
      ($("situation").textContent = "Could not load your disputes. Try again."),
  );
  loadActivity();
  onHash();
  setInterval(
    () => document.visibilityState === "visible" && loadActivity(),
    5000,
  );
}
init();

import { useEffect, useReducer, useRef } from "react";
import {
  api,
  post,
  put,
  ApiError,
  type AddedEvidence,
  type Analysis,
  type Claim,
} from "../lib/api";
import { money, needsResponse } from "../lib/format";

export type Pending = "evidence" | "accept" | null;

/** Everything the open case keeps between renders; a fresh object per case id. */
interface State {
  id: string;
  analysis: Analysis | null;
  error: string | null;
  actionError: string | null;
  inputs: { prior: string; c: string; fee: string };
  added: Map<string, AddedEvidence>;
  fightAnyway: boolean;
  sent: string | null;
  sentText: string | null;
  sentKind: "evidence" | "accept" | null;
  sentEvidence: AddedEvidence[];
  work: Analysis["work"];
  editedLocal: boolean;
  draftAi: boolean;
  draftLabel: string | null;
  draftText: string;
  draftNote: { text: string; error: boolean } | null;
  vouched: string[];
  claims: Claim[];
  pending: Pending;
  loading: boolean;
  drafting: boolean;
  busy: boolean;
  scrollSeq: number;
  // bookkeeping that app.js kept in module variables
  saveTimer: ReturnType<typeof setTimeout> | null;
  saveChain: Promise<void>;
  draftSeq: number;
}

const fresh = (id: string): State => ({
  id,
  analysis: null,
  error: null,
  actionError: null,
  inputs: { prior: "", c: "15.00", fee: "0.00" },
  added: new Map(),
  fightAnyway: false,
  sent: null,
  sentText: null,
  sentKind: null,
  sentEvidence: [],
  work: null,
  editedLocal: false,
  draftAi: false,
  draftLabel: null,
  draftText: "",
  draftNote: null,
  vouched: [],
  claims: [],
  pending: null,
  loading: true,
  drafting: false,
  busy: false,
  scrollSeq: 0,
  saveTimer: null,
  saveChain: Promise.resolve(),
  draftSeq: 0,
});

const canon = (added: Map<string, AddedEvidence>) =>
  [...added.values()].map(({ file: _f, ...e }) => e);
// names what is sent: items added now plus statements the merchant vouched for
const short = (item: string) =>
  (/\(([^)]+)\)/.exec(item)?.[1] ?? item).trim().toLowerCase();

export function useCase(
  id: string,
  opts: { onWritten(): Promise<void>; onAiDraft(): void },
) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const ref = useRef<State>(fresh(id));
  if (ref.current.id !== id) {
    if (ref.current.saveTimer) clearTimeout(ref.current.saveTimer);
    ref.current = fresh(id);
  }
  const s = ref.current;
  // async work reads the live object and gives up once the case changed
  const live = () => s === ref.current;
  const set = (patch: Partial<State>) => {
    if (!live()) return;
    Object.assign(s, patch);
    bump();
  };
  const url = (tail: string) => `/api/cases/${encodeURIComponent(id)}${tail}`;

  async function recompute(fresh: boolean) {
    const q = new URLSearchParams();
    const p = s.inputs.prior.trim();
    if (p !== "") {
      const v = Number(p);
      if (!(v >= 0 && v <= 100))
        return set({ error: "Win chance must be between 0 and 100." });
      q.set("prior", String(v / 100));
    }
    q.set("c", s.inputs.c || "15");
    q.set("fee", s.inputs.fee || "0");
    let a: Analysis;
    try {
      a = await api<Analysis>(url(`/analysis?${q}`));
    } catch {
      return set({ error: "Could not load this case. Try again.", loading: false });
    }
    if (!live()) return;
    const patch: Partial<State> = { analysis: a, error: null };
    if (fresh) {
      const work = a.work ?? null;
      patch.work = work;
      patch.added = new Map((work?.added ?? []).map((e) => [e.item, e]));
      patch.editedLocal = !!work?.edited;
      if (a.sent) {
        patch.sentText = a.sent.text ?? s.sentText;
        patch.sentEvidence = a.sent.added ?? [];
        patch.vouched = a.sent.vouched ?? [];
      }
    }
    const dr = a.draft;
    if (fresh && patch.work?.draft_text) patch.draftText = patch.work.draft_text;
    else if (fresh || !s.draftText) patch.draftText = dr.response;
    if (fresh) patch.draftLabel = patch.work?.draft_label ?? dr.label ?? null;
    const label = fresh ? patch.draftLabel : s.draftLabel;
    patch.draftAi = dr.source === "llm" || /^AI draft/.test(label ?? "");
    if (fresh) patch.loading = false;
    set(patch);
    if (patch.draftAi) opts.onAiDraft();
  }

  // the server keeps the unsent work, so a reload or another browser sees it
  function saveWork(delay = 0) {
    if (s.sent || !s.analysis || !needsResponse(s.analysis.case)) return;
    if (s.saveTimer) clearTimeout(s.saveTimer);
    s.saveTimer = setTimeout(() => {
      const body = {
        added: canon(s.added),
        text: s.draftText,
        edited: s.editedLocal,
      };
      s.saveChain = s.saveChain.then(async () => {
        try {
          const r = await put(url("/work"), body);
          if (live() && r?.draft_label && !s.editedLocal)
            set({ draftLabel: r.draft_label });
        } catch {} // old server: nothing to save to
      });
    }, delay);
  }

  function setDraft(text: string) {
    set({ draftText: text, editedLocal: true });
    saveWork(800);
  }

  async function redraft() {
    const seq = ++s.draftSeq;
    set({
      drafting: true,
      draftNote: {
        text: "Rewriting the draft with your new evidence…",
        error: false,
      },
    });
    let res: { response?: string; source?: string; label?: string } | null =
      null;
    try {
      res = (await post(url("/draft"), { added: canon(s.added) })).draft;
    } catch {}
    if (seq !== s.draftSeq || !live()) return;
    if (res?.response) {
      const draftAi = res.source === "llm";
      set({
        drafting: false,
        draftText: res.response,
        draftAi,
        editedLocal: false,
        draftLabel: res.label ?? null,
        draftNote: null,
      });
      if (draftAi) opts.onAiDraft();
      saveWork();
    } else {
      set({
        drafting: false,
        draftNote: {
          text: "Could not update the draft; your evidence will still be sent.",
          error: true,
        },
      });
    }
  }

  function addEvidence(ev: AddedEvidence) {
    s.added.set(ev.item, ev);
    bump();
    saveWork(0);
    void redraft();
  }
  function undo(item: string) {
    s.added.delete(item);
    bump();
    saveWork(0);
    void redraft();
  }

  // the server looks for claims with no evidence on file; an old server has no check, so nothing is flagged
  async function checkDraft() {
    const prev = new Map(s.claims.map((c) => [c.sentence, c.ok]));
    let claims: Claim[];
    try {
      const r = await post(url("/check"), {
        text: s.draftText,
        evidence: canon(s.added),
        vouched: [],
        attested: [],
      });
      claims = (r.sentences ?? r.unsupported ?? []).map((x: Claim) => ({
        ...x,
        ok: prev.get(x.sentence) ?? false,
      }));
    } catch (e) {
      const body = e instanceof ApiError ? e.body : null;
      claims = (body?.sentences ?? []).map((x: Claim) => ({ ...x, ok: false }));
    }
    set({ claims });
  }

  // checks first, then asks inside the page; run() sends once the person agrees
  async function act(kind: "evidence" | "accept") {
    set({ claims: [] });
    if (kind === "evidence") {
      set({ busy: true });
      await checkDraft();
      set({ busy: false, pending: kind });
    } else set({ pending: kind });
  }

  function toggleClaim(i: number, ok: boolean) {
    const c = s.claims[i];
    if (c) c.ok = ok;
    bump();
  }
  function cancelConfirm() {
    set({ pending: null, claims: [] });
  }

  async function run() {
    const kind = s.pending;
    const a = s.analysis;
    if (!kind || !a) return;
    const vouchedNow = s.claims.filter((c) => c.ok).map((c) => c.sentence);
    const attestedNow = s.claims
      .filter((c) => c.ok && c.kind === "added")
      .map((c) => c.sentence);
    set({ busy: true });
    let body: Record<string, unknown>;
    if (kind === "evidence") {
      const items = [...s.added.values()];
      const files = items.map((e) => e.file).filter(Boolean);
      const evidence = canon(s.added);
      body = { confirm: true, text: s.draftText };
      if (evidence.length) body.evidence = evidence;
      if (files.length) body.files = files;
      if (vouchedNow.length) body.vouched = vouchedNow;
      if (attestedNow.length) body.attested = attestedNow;
    } else {
      body = { note: "Accepted by the seller from the desk", confirm: true };
    }
    try {
      await post(url(`/${kind}`), body);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.status === 422 && err.body?.error === "unsupported_claim") {
        set({
          busy: false,
          claims: (err.body.sentences ?? []).map((x: Claim) => ({
            ...x,
            ok: false,
          })),
        });
        return;
      }
      const why = err?.body?.detail ? `: ${err.body.detail}` : ". Try again.";
      set({
        busy: false,
        pending: null,
        claims: [],
        actionError: `PayPal did not accept the ${kind === "evidence" ? "response" : "refund"}${why}`,
      });
      return;
    }
    if (s.saveTimer) clearTimeout(s.saveTimer);
    const patch: Partial<State> = {
      busy: false,
      pending: null,
      claims: [],
      sentKind: kind,
      sent:
        kind === "evidence"
          ? "Sent to PayPal. The case is now under review; PayPal decides within about 30 days."
          : "Refund sent. The case is closed.",
      added: new Map(),
    };
    if (kind === "evidence") {
      patch.sentText = s.draftText;
      patch.sentEvidence = canon(s.added);
      patch.vouched = vouchedNow;
    }
    set(patch);
    await opts.onWritten();
    set({ actionError: null }); // the rec box is the single status message
    await recompute(true);
    set({ scrollSeq: s.scrollSeq + 1 });
  }

  useEffect(() => {
    void recompute(true);
    return () => {
      if (s.saveTimer) clearTimeout(s.saveTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const a = s.analysis;
  const c = a?.case;
  const d = a?.decision ?? null;
  const reviewing = c?.status === "UNDER_REVIEW" || s.sentKind === "evidence";
  const refunded =
    s.sentKind === "accept" || c?.outcome === "RESOLVED_BUYER_FAVOUR";
  const done = reviewing || refunded;
  const canAct = !!c && needsResponse(c) && !s.sent;
  const isFight = !d || d.call === "fight" || s.fightAnyway;
  const missing = (a?.draft.checklist ?? []).filter(
    (i) => i.status === "missing" && i.required !== false, // old servers send no flag
  );
  const stillMissing = missing.filter((i) => !s.added.has(i.item));
  const chose = s.fightAnyway && d?.call === "accept";
  const badge = !a
    ? "Drafting with AI…"
    : s.editedLocal
      ? s.draftAi
        ? "AI draft, edited by you"
        : "Template, edited by you"
      : (s.draftLabel ?? (s.draftAi ? "AI draft" : "Drafted from the case facts"));
  const labelGreen = !!a && s.draftAi && !/^Drafted from/.test(badge);
  const confirmText = c
    ? (() => {
        const names = [
          ...[...s.added.values()].map((e) => short(e.item)),
          ...s.claims.filter((x) => x.ok).map(() => "your statement"),
        ];
        const what =
          names.length === 0
            ? ""
            : names.length === 1
              ? ` and the ${names[0]}`
              : ` and ${names.length} items (${names.join(", ")})`;
        return `Send your response${what} to PayPal for the ${money(c.amount_cents, c.currency)} dispute with ${c.buyer}?`;
      })()
    : "";

  return {
    analysis: a,
    error: s.error,
    actionError: s.actionError,
    inputs: s.inputs,
    setInput: (k: keyof State["inputs"], v: string) =>
      set({ inputs: { ...s.inputs, [k]: v } }),
    added: s.added,
    fightAnyway: s.fightAnyway,
    sent: s.sent,
    sentText: s.sentText,
    sentKind: s.sentKind,
    sentEvidence: s.sentEvidence,
    vouched: s.vouched,
    draftText: s.draftText,
    draftNote: s.draftNote,
    claims: s.claims,
    pending: s.pending,
    drafting: s.drafting,
    busy: s.busy,
    dim: s.loading || s.drafting,
    scrollSeq: s.scrollSeq,
    recompute,
    setDraft,
    addEvidence,
    undo,
    redraft,
    checkDraft,
    act,
    toggleClaim,
    cancelConfirm,
    run,
    setFightAnyway: () => set({ fightAnyway: true }),
    canAct,
    isFight,
    chose,
    done,
    refunded,
    missing,
    stillMissing,
    confirmText,
    badge,
    labelGreen,
    cost: Number(s.inputs.c) || 15,
  };
}

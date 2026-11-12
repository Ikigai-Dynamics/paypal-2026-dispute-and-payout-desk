import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, post } from "../lib/api";
import type { CaseSummary } from "../lib/api";
import { callKind, money, needsResponse } from "../lib/format";
import "./chat.css";

interface Staged {
  id: string;
  title: string;
  note?: string;
  paypal: { method: string; path: string; body: unknown };
  desk: { method: string; path: string; body: unknown };
}
interface Msg {
  id: string;
  role: "user" | "parley";
  text: string;
  actions?: { staged?: Staged[]; list?: { id: string; line: string }[] } | null;
}
interface Conv {
  id: string;
  title: string | null;
  updated_at: string;
}
type Outcome = { ok: boolean; text: string } | "declined";

const GREETING =
  "Hi, I'm Parley. I've read your open disputes. Ask me which to fight, refund or offer on, or tell me to make an offer, and I'll get it ready for your OK.";
/** Suggestions that fit the live state: an offer chip only while that offer is still unsent. */
export function chipsFor(cases: CaseSummary[]): string[] {
  const c = cases.find((x) => needsResponse(x) && callKind(x.call) === "offer");
  const what = c && (c.item ?? c.items?.[0]?.item_description ?? "case");
  return [
    "Which case should I deal with first?",
    "Which cases should I just refund?",
    ...(c ? [`Send the offer to ${c.buyer} on the ${what} (${money(c.offer_cents ?? c.amount_cents, c.currency, true)})`] : []),
  ];
}

const fire = (name: string, detail?: unknown) =>
  window.dispatchEvent(new CustomEvent(name, { detail }));

function dispatchUi(actions: any[], reply: string) {
  for (const a of actions) {
    if (a.type === "select_case") fire("parley:select-case", { id: a.id });
    else if (a.type === "open_tab") fire("parley:open-tab", { tab: a.tab });
    else if (a.type === "filter") fire("parley:filter", { ids: a.ids });
    else if (a.type === "highlight_evidence") fire("parley:highlight-evidence");
  }
  // A filter alone should still open a case: the only one, or the first.
  const f = actions.find((a) => a.type === "filter" && a.ids?.length);
  if (f && !actions.some((a) => a.type === "select_case"))
    fire("parley:select-case", { id: f.ids[0] });
  const first = /^.*?[.!?](\s|$)/s.exec(reply)?.[0].trim() ?? reply;
  fire("parley:say", { text: first });
}

function StagedCard({
  s,
  settledBefore,
  onDone,
}: {
  s: Staged;
  settledBefore?: string;
  onDone: (ok: boolean, text: string) => void;
}) {
  const [state, setState] = useState<Outcome | "busy" | null>(
    settledBefore
      ? settledBefore.startsWith("Sent")
        ? { ok: true, text: "Sent through PayPal" }
        : "declined"
      : null,
  );
  const settle = async (ok: boolean, text: string) => {
    setState(ok ? { ok, text } : "declined");
    await post(`/api/chat/staged/${s.id}/approved`, { ok }).catch(
      () => undefined,
    );
    onDone(ok, text);
  };
  const send = async () => {
    setState("busy");
    try {
      await api(s.desk.path, {
        method: s.desk.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(s.desk.body),
      });
      const id = s.desk.path.split("/")[3];
      fire("parley:select-case", { id });
      fire("parley:changed", { id });
      await settle(true, "Sent through PayPal");
    } catch (e) {
      const detail =
        e instanceof ApiError
          ? (e.body?.detail ?? "PayPal did not accept it")
          : "The request did not go through. Try again.";
      setState({ ok: false, text: String(detail) });
    }
  };
  const done = state && state !== "busy";
  return (
    <div className="pc-card">
      <h4>Needs your OK</h4>
      <div className="t">{s.title}</div>
      <div className="hint">The exact PayPal call</div>
      <pre>{`${s.paypal.method} ${s.paypal.path}\n${JSON.stringify(s.paypal.body, null, 2)}`}</pre>
      {state === "declined" && <div className="muted">Not sent.</div>}
      {typeof state === "object" && state && (
        <div className={state.ok ? "ok" : "err"}>{state.text}</div>
      )}
      {s.note && !done && <div className="note">{s.note}</div>}
      {(!done || (typeof state === "object" && state && !state.ok)) && (
        <div className="row">
          <button
            className="primary"
            disabled={state === "busy"}
            onClick={send}
          >
            Send to PayPal
          </button>
          <button
            className="pc-chip"
            disabled={state === "busy"}
            onClick={() => settle(false, "")}
          >
            Not now
          </button>
        </div>
      )}
    </div>
  );
}

export function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [cid, setCid] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [memory, setMemory] = useState<{ id: string; fact: string }[]>([]);
  const [showMem, setShowMem] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [chips, setChips] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const caseId = useRef<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  const loadConvs = useCallback(async () => {
    const r = await api("/api/chat/conversations").catch(() => ({
      conversations: [],
    }));
    setConvs(r.conversations);
    return r.conversations as Conv[];
  }, []);
  const loadMem = useCallback(
    () =>
      api("/api/chat/memory")
        .then((r) => setMemory(r.memory))
        .catch(() => undefined),
    [],
  );
  const choose = useCallback(async (id: string) => {
    setCid(id);
    const r = await api(`/api/chat/conversations/${id}`).catch(() => ({
      messages: [],
    }));
    setMsgs(r.messages);
  }, []);

  const loadChips = useCallback(
    () =>
      api("/api/cases")
        .then((r) => setChips(chipsFor(r.cases ?? [])))
        .catch(() => undefined),
    [],
  );
  useEffect(() => {
    window.addEventListener("parley:changed", loadChips);
    window.addEventListener("parley:sent", loadChips);
    return () => {
      window.removeEventListener("parley:changed", loadChips);
      window.removeEventListener("parley:sent", loadChips);
    };
  }, [loadChips]);

  useEffect(() => {
    const onOpen = async () => {
      setOpen(true);
      loadChips();
      const l = await loadConvs();
      if (!cid && l[0]) await choose(l[0].id);
      loadMem();
    };
    const onCase = (e: Event) => {
      caseId.current = (e as CustomEvent).detail?.id ?? null;
    };
    window.addEventListener("parley:open-chat", onOpen);
    window.addEventListener("parley:case-changed", onCase);
    return () => {
      window.removeEventListener("parley:open-chat", onOpen);
      window.removeEventListener("parley:case-changed", onCase);
    };
  }, [cid, choose, loadConvs, loadMem, loadChips]);

  useEffect(() => {
    document.body.classList.toggle("chat-open", open);
    return () => document.body.classList.remove("chat-open");
  }, [open]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [msgs, open]);

  const newChat = async () => {
    const r = await post("/api/chat/conversations", {
      case_id: caseId.current,
    });
    setMsgs([]);
    setCid(r.conversation.id);
    loadConvs();
  };
  const submit = async (raw: string) => {
    const t = raw.trim();
    if (!t || busy) return;
    setBusy(true);
    setText("");
    let id = cid;
    try {
      if (!id) {
        id = (
          await post("/api/chat/conversations", { case_id: caseId.current })
        ).conversation.id as string;
        setCid(id);
      }
      setMsgs((m) => [...m, { id: `l${Date.now()}`, role: "user", text: t }]);
      const r = await post(`/api/chat/conversations/${id}/messages`, {
        text: t,
        case_id: caseId.current ?? undefined,
        tz_offset: new Date().getTimezoneOffset(),
      });
      setMsgs((m) => [...m, r.message]);
      dispatchUi(r.ui_actions, r.message.text);
      if (r.remembered?.length) loadMem();
      loadConvs();
    } catch {
      setMsgs((m) => [
        ...m,
        {
          id: `e${Date.now()}`,
          role: "parley",
          text: "I could not answer just now. Try again in a moment.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  };
  const sendText = (e: React.FormEvent) => {
    e.preventDefault();
    return submit(text);
  };
  const lastAsked = [...msgs].reverse().find((m) => m.role === "user")?.text;
  const logLine = () => cid && choose(cid);

  return (
    <aside className="parley-chat" hidden={!open} aria-label="Chat with Parley">
      <div className="pc-head">
        <select
          className="pc-select"
          value={cid ?? ""}
          onChange={(e) => choose(e.target.value)}
          aria-label="Conversation"
        >
          <option value="" disabled>
            Earlier chats
          </option>
          {convs.map((c) => (
            <option key={c.id} value={c.id}>
              {(c.title ?? "Chat") +
                " · " +
                new Date(c.updated_at).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
            </option>
          ))}
        </select>
        <button className="pc-chip" onClick={newChat}>
          New chat
        </button>
        <button
          className="pc-chip"
          onClick={() => {
            setShowMem((v) => !v);
            loadMem();
          }}
          aria-pressed={showMem}
        >
          Memory
        </button>
        <button
          className="pc-x"
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      {showMem && (
        <div className="pc-memory">
          {memory.length === 0 ? (
            <span className="muted">
              Nothing remembered yet. Say "remember I ship with USPS".
            </span>
          ) : (
            <ul>
              {memory.map((m) => (
                <li key={m.id}>
                  <span>{m.fact}</span>
                  <button
                    className="pc-chip small"
                    onClick={async () => {
                      await api(`/api/chat/memory/${m.id}`, {
                        method: "DELETE",
                      });
                      loadMem();
                    }}
                  >
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="pc-log" ref={log}>
        {msgs.length === 0 && (
          <>
            <div className="pc-msg parley">{GREETING}</div>
            <div className="pc-chips">
              {chips.map((c) => (
                <button
                  key={c}
                  className="pc-chip"
                  disabled={busy}
                  onClick={() => submit(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          </>
        )}
        {msgs.map((m) => (
          <div key={m.id} style={{ display: "contents" }}>
            <div className={`pc-msg ${m.role}`}>{m.text}</div>
            {m.actions?.list?.map((it) => (
              <button
                key={it.id}
                className={`pc-item${picked === it.id ? " active" : ""}`}
                onClick={() => {
                  setPicked(it.id);
                  fire("parley:select-case", { id: it.id });
                }}
              >
                <span aria-hidden>•</span> {it.line}
              </button>
            ))}
            {m.actions?.staged?.map((s) => (
              <StagedCard
                key={s.id}
                s={s}
                settledBefore={
                  msgs.find(
                    (x) =>
                      x.role === "parley" &&
                      (x.text.startsWith(`Sent to PayPal: ${s.title}`) ||
                        x.text.startsWith(`Not sent: ${s.title}`)),
                  )?.text
                }
                onDone={logLine}
              />
            ))}
          </div>
        ))}
        {busy && <div className="pc-msg parley muted">Thinking…</div>}
      </div>
      {msgs.length > 0 && !busy && (
        <div className="pc-next">
          {chips
            .filter((c) => c !== lastAsked)
            .map((c) => (
              <button key={c} className="pc-chip" onClick={() => submit(c)}>
                {c}
              </button>
            ))}
        </div>
      )}
      <form className="pc-form" onSubmit={sendText}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message Parley…"
          aria-label="Message Parley"
        />
        <button className="primary" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}

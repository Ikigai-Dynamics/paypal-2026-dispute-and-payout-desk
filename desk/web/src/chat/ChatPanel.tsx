import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, post } from "../lib/api";
import "./chat.css";

interface Staged {
  id: string;
  title: string;
  paypal: { method: string; path: string; body: unknown };
  desk: { method: string; path: string; body: unknown };
}
interface Msg {
  id: string;
  role: "user" | "parley";
  text: string;
  actions?: { staged?: Staged[] } | null;
}
interface Conv {
  id: string;
  title: string | null;
  updated_at: string;
}
type Outcome = { ok: boolean; text: string } | "declined";

const fire = (name: string, detail?: unknown) =>
  window.dispatchEvent(new CustomEvent(name, { detail }));

function dispatchUi(actions: any[], reply: string) {
  for (const a of actions) {
    if (a.type === "select_case") fire("parley:select-case", { id: a.id });
    else if (a.type === "open_tab") fire("parley:open-tab", { tab: a.tab });
    else if (a.type === "filter") fire("parley:filter", { ids: a.ids });
    else if (a.type === "highlight_evidence") fire("parley:highlight-evidence");
  }
  const first = /^.*?[.!?](\s|$)/s.exec(reply)?.[0].trim() ?? reply;
  fire("parley:say", { text: first });
}

function StagedCard({ s, settledBefore, onDone }: { s: Staged; settledBefore?: string; onDone: (ok: boolean, text: string) => void }) {
  const [state, setState] = useState<Outcome | "busy" | null>(settledBefore ? (settledBefore.startsWith("Sent") ? { ok: true, text: "Sent through PayPal" } : "declined") : null);
  const settle = async (ok: boolean, text: string) => {
    setState(ok ? { ok, text } : "declined");
    await post(`/api/chat/staged/${s.id}/approved`, { ok, result: text }).catch(() => undefined);
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
      fire("parley:select-case", { id: s.desk.path.split("/")[3] });
      await settle(true, "Sent through PayPal");
    } catch (e) {
      const detail = e instanceof ApiError ? (e.body?.detail ?? "PayPal did not accept it") : "The request did not go through. Try again.";
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
      {(!done || (typeof state === "object" && state && !state.ok)) && (
        <div className="row">
          <button className="primary" disabled={state === "busy"} onClick={send}>
            Send to PayPal
          </button>
          <button className="pc-chip" disabled={state === "busy"} onClick={() => settle(false, "")}>
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
  const caseId = useRef<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  const loadConvs = useCallback(async () => {
    const r = await api("/api/chat/conversations").catch(() => ({ conversations: [] }));
    setConvs(r.conversations);
    return r.conversations as Conv[];
  }, []);
  const loadMem = useCallback(
    () => api("/api/chat/memory").then((r) => setMemory(r.memory)).catch(() => undefined),
    [],
  );
  const choose = useCallback(async (id: string) => {
    setCid(id);
    const r = await api(`/api/chat/conversations/${id}`).catch(() => ({ messages: [] }));
    setMsgs(r.messages);
  }, []);

  useEffect(() => {
    const onOpen = async () => {
      setOpen(true);
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
  }, [cid, choose, loadConvs, loadMem]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [msgs, open]);

  const newChat = async () => {
    const r = await post("/api/chat/conversations", { case_id: caseId.current });
    setMsgs([]);
    setCid(r.conversation.id);
    loadConvs();
  };
  const sendText = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setText("");
    let id = cid;
    try {
      if (!id) {
        id = (await post("/api/chat/conversations", { case_id: caseId.current })).conversation.id as string;
        setCid(id);
      }
      setMsgs((m) => [...m, { id: `l${Date.now()}`, role: "user", text: t }]);
      const r = await post(`/api/chat/conversations/${id}/messages`, { text: t, case_id: caseId.current ?? undefined });
      setMsgs((m) => [...m, r.message]);
      dispatchUi(r.ui_actions, r.message.text);
      if (r.remembered?.length) loadMem();
      loadConvs();
    } catch {
      setMsgs((m) => [...m, { id: `e${Date.now()}`, role: "parley", text: "I could not answer just now. Try again in a moment." }]);
    } finally {
      setBusy(false);
    }
  };
  const logLine = () => cid && choose(cid);

  return (
    <aside className="parley-chat" hidden={!open} aria-label="Chat with Parley">
      <div className="pc-head">
        <select className="pc-select" value={cid ?? ""} onChange={(e) => choose(e.target.value)} aria-label="Conversation">
          <option value="" disabled>
            Earlier chats
          </option>
          {convs.map((c) => (
            <option key={c.id} value={c.id}>
              {(c.title ?? "Chat") + " · " + new Date(c.updated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </option>
          ))}
        </select>
        <button className="pc-chip" onClick={newChat}>New chat</button>
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
        <button className="pc-x" type="button" onClick={() => setOpen(false)} aria-label="Close">
          ×
        </button>
      </div>
      {showMem && (
        <div className="pc-memory">
          {memory.length === 0 ? (
            <span className="muted">Nothing remembered yet. Say "remember I ship with USPS".</span>
          ) : (
            <ul>
              {memory.map((m) => (
                <li key={m.id}>
                  <span>{m.fact}</span>
                  <button
                    className="pc-chip small"
                    onClick={async () => {
                      await api(`/api/chat/memory/${m.id}`, { method: "DELETE" });
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
        {msgs.length === 0 && <div className="muted">Ask me about a case, or tell me what to do.</div>}
        {msgs.map((m) => (
          <div key={m.id} style={{ display: "contents" }}>
            <div className={`pc-msg ${m.role}`}>{m.text}</div>
            {m.actions?.staged?.map((s) => (
              <StagedCard
                key={s.id}
                s={s}
                settledBefore={msgs.find((x) => x.role === "parley" && (x.text.startsWith(`Sent to PayPal: ${s.title}`) || x.text.startsWith(`Not sent: ${s.title}`)))?.text}
                onDone={logLine}
              />
            ))}
          </div>
        ))}
        {busy && <div className="pc-msg parley muted">Thinking…</div>}
      </div>
      <form className="pc-form" onSubmit={sendText}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message Parley…" aria-label="Message Parley" />
        <button className="primary" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}

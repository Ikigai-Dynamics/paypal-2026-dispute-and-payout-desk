import { useCallback, useEffect, useRef, useState } from "react";
import { useActivity } from "./hooks/useActivity";
import { needing, useCases } from "./hooks/useCases";
import { useInfo } from "./hooks/useInfo";
import { AllCases } from "./components/AllCases";
import { DeadlinesTimeline } from "./components/DeadlinesTimeline";
import { DeveloperPage } from "./components/DeveloperPage";
import { DemoGate } from "./components/DemoGate";
import { DisputeList } from "./components/DisputeList";
import { PayPalFooter } from "./components/PayPalFooter";
import { Tiles } from "./components/Tiles";
import { CasePanel, type Tab } from "./case/CasePanel";
import { Owl } from "./parley/Owl";
import { line } from "./parley/lines";
import { needsResponse } from "./lib/format";
import type { CaseSummary, Decision } from "./lib/api";

const HINT_KEY = "parley.hint-dismissed";
const hintSeen = () => {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
};

// the hash drives opening, so back/forward and reload work
const hashId = () => {
  const m = /^#case=(.+)$/.exec(location.hash);
  try {
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
};
const TABS: Tab[] = ["evidence", "buyer", "draft", "activity", "math"];
const detail = <T,>(e: Event) => (e as CustomEvent<T>).detail;

export function App() {
  const info = useInfo();
  const { cases, summary, error, retry, failure, reload } = useCases();
  const activity = useActivity();
  const [dev, setDev] = useState(() => location.hash === "#developers");
  const [openId, setOpenId] = useState<string | null>(hashId);
  const [reopen, setReopen] = useState(0); // bumps when the open case is opened again
  const [tab, setTab] = useState<Tab>("evidence");
  const [highlight, setHighlight] = useState(0);
  const [lit, setLit] = useState<string[] | null>(null);
  const [speech, setSpeech] = useState<{ text: string; seq: number } | null>(null);
  const [tucked, setTucked] = useState(false);
  const spoke = useRef<string | null>(null);
  const bootId = useRef<string | undefined>(undefined);
  const [wasReset, setWasReset] = useState(false);
  const loaded = cases.length > 0;
  const [decisions, setDecisions] = useState<Record<string, Decision | null>>({});
  const [hint, setHint] = useState(() => !hintSeen());
  const dismissHint = useCallback(() => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {}
  }, []);
  const onDecision = useCallback((id: string, d: Decision | null) => setDecisions((m) => ({ ...m, [id]: d })), []);

  // a restart resets the saved drafts: reload the open case so Send diffs against the current one
  useEffect(() => {
    if (!info?.bootId) return;
    if (bootId.current && bootId.current !== info.bootId && openId) {
      setReopen((n) => n + 1);
      setWasReset(true);
    }
    bootId.current = info.bootId;
  }, [info?.bootId]);

  useEffect(() => setWasReset(false), [openId]);
  useEffect(() => {
    const onHash = () => {
      setDev(location.hash === "#developers");
      setOpenId(hashId());
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const openCase = useCallback((id: string) => {
    setWasReset(false);
    dismissHint();
    if (location.hash === `#case=${encodeURIComponent(id)}`) setReopen((n) => n + 1);
    else location.hash = `case=${encodeURIComponent(id)}`;
  }, []);

  // the first screen tells the story: the soonest-due dispute is open on load
  useEffect(() => {
    if (openId || !loaded || dev) return;
    const first = needing(cases)[0] ?? cases.find(needsResponse) ?? cases[0];
    if (!first) return;
    history.replaceState(null, "", `#case=${encodeURIComponent(first.dispute_id)}`);
    setOpenId(first.dispute_id);
  }, [openId, loaded, dev]);

  // a new case: Parley says his line, and the chat (if any) is told
  useEffect(() => {
    if (!openId) return;
    const c = cases.find((x) => x.dispute_id === openId);
    if (c) {
      // the opened case's own decision wins over the list summary, so the owl and the card cannot differ
      const d = decisions[openId];
      const sum: CaseSummary = d
        ? { ...c, call: d.call, p: d.p, offer_cents: d.offer?.amount_cents ?? null, keep_cents: d.keep_cents ?? c.keep_cents, margin_cents: d.margin_cents }
        : c;
      const text = line(sum, !!info?.llm?.online);
      setSpeech((s) => (s?.text === text && spoke.current === openId ? s : { text, seq: (s?.seq ?? 0) + 1 }));
      spoke.current = openId;
    }
  }, [openId, cases, decisions[openId ?? ""], info?.llm?.online]);
  useEffect(() => {
    if (openId) window.dispatchEvent(new CustomEvent("parley:case-changed", { detail: { id: openId } }));
  }, [openId]);

  // the chat acts on the page through these events
  useEffect(() => {
    const on: Record<string, (e: Event) => void> = {
      "parley:select-case": (e) => {
        const id = detail<{ id?: string }>(e)?.id;
        if (id) openCase(id);
      },
      "parley:open-tab": (e) => {
        const t = detail<{ tab?: Tab }>(e)?.tab;
        if (t && TABS.includes(t)) setTab(t);
      },
      "parley:filter": (e) => {
        const ids = detail<{ ids?: string[] | null }>(e)?.ids;
        setLit(Array.isArray(ids) ? ids : null);
      },
      "parley:highlight-evidence": () => {
        setTab("evidence");
        setHighlight((n) => n + 1);
      },
    };
    for (const [k, f] of Object.entries(on)) addEventListener(k, f);
    return () => {
      for (const [k, f] of Object.entries(on)) removeEventListener(k, f);
    };
  }, [openCase]);

  // the chat sent something for a case: refresh the list, the log and (through CasePanel) the open case
  useEffect(() => {
    const on = () => {
      void reload().catch(() => {});
      void activity.reload();
    };
    addEventListener("parley:changed", on);
    addEventListener("parley:open-chat", dismissHint);
    return () => {
      removeEventListener("parley:changed", on);
      removeEventListener("parley:open-chat", dismissHint);
    };
  }, [reload, activity.reload, dismissHint]);

  const onWritten = useCallback(async () => {
    await activity.reload();
    await reload().catch(() => {});
    window.dispatchEvent(new Event("parley:sent")); // the chat's chips look again
  }, [activity.reload, reload]);

  return (
    <>
      <div className="wrap">
        {info?.sync?.error && (
          <div className="banner warn">PayPal is unreachable right now: showing the last synced cases.</div>
        )}
        {wasReset && (
          <div className="banner warn">
            The desk was reset since you opened this page: the case was reloaded with the current draft.
          </div>
        )}
        <header>
          <div className="brand">
            <h1>
              <a href="/" title="Parley home">Parley</a>
            </h1>
            <small>your dispute desk</small>
          </div>
          <div className="btns">
            <a className="chip" href="#developers">
              Developers
            </a>
            <button type="button" className="chip" onClick={() => setTucked(!tucked)}>
              {tucked ? "Bring Parley back" : "Tuck Parley away"}
            </button>
          </div>
        </header>
        {dev ? (
          <DeveloperPage />
        ) : (
          <>
        <Tiles cases={cases} summary={summary} />
        {hint && (
          <p className="hint-line">
            Start with the top case, or click Parley to ask a question.
            <button type="button" aria-label="Dismiss" onClick={dismissHint}>
              ×
            </button>
          </p>
        )}
        <DeadlinesTimeline cases={cases} onOpen={openCase} selectedId={openId} />
        <section className="main">
          <DisputeList
            cases={cases}
            selectedId={openId}
            lit={lit}
            onOpen={openCase}
            onClearFilter={() => setLit(null)}
            loadError={error}
          />
          {error && !loaded ? (
            <div className="panel">
              <p className="errbox">Could not load your disputes.</p>
              <button type="button" className="btn" onClick={retry}>
                Try again
              </button>
            </div>
          ) : (
            openId && (
              <CasePanel
                key={openId + ":" + reopen}
                id={openId}
                cases={cases}
                calls={activity.calls}
                tab={tab}
                onTab={setTab}
                highlight={highlight}
                onWritten={onWritten}
                onAiDraft={() => {}}
                onDecision={onDecision}
              />
            )
          )}
        </section>
        <AllCases cases={cases} onOpen={openCase} onReload={reload} />
          </>
        )}
        <PayPalFooter calls={activity.calls} failed={failure} info={info} />
      </div>
      <Owl speech={speech} tucked={tucked} />
      <DemoGate />
    </>
  );
}

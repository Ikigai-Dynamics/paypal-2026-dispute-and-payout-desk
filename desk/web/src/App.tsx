import { useCallback, useEffect, useRef, useState } from "react";
import { useActivity } from "./hooks/useActivity";
import { needing, useCases } from "./hooks/useCases";
import { useInfo } from "./hooks/useInfo";
import { AllCases } from "./components/AllCases";
import { DeadlinesTimeline } from "./components/DeadlinesTimeline";
import { DisputeList } from "./components/DisputeList";
import { PayPalFooter } from "./components/PayPalFooter";
import { Tiles } from "./components/Tiles";
import { CasePanel, type Tab } from "./case/CasePanel";
import { Owl } from "./parley/Owl";
import { line } from "./parley/lines";
import { needsResponse } from "./lib/format";

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
  const { cases, error, retry, failure, reload } = useCases();
  const activity = useActivity();
  const [openId, setOpenId] = useState<string | null>(hashId);
  const [reopen, setReopen] = useState(0); // bumps when the open case is opened again
  const [tab, setTab] = useState<Tab>("evidence");
  const [highlight, setHighlight] = useState(0);
  const [lit, setLit] = useState<string[] | null>(null);
  const [speech, setSpeech] = useState<{ text: string; seq: number } | null>(null);
  const [tucked, setTucked] = useState(false);
  const bootId = useRef<string | undefined>(undefined);
  const [wasReset, setWasReset] = useState(false);
  const loaded = cases.length > 0;

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
    const onHash = () => setOpenId(hashId());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const openCase = useCallback((id: string) => {
    setWasReset(false);
    if (location.hash === `#case=${encodeURIComponent(id)}`) setReopen((n) => n + 1);
    else location.hash = `case=${encodeURIComponent(id)}`;
  }, []);

  // the first screen tells the story: the soonest-due dispute is open on load
  useEffect(() => {
    if (openId || !loaded) return;
    const first = needing(cases)[0] ?? cases.find(needsResponse) ?? cases[0];
    if (!first) return;
    history.replaceState(null, "", `#case=${encodeURIComponent(first.dispute_id)}`);
    setOpenId(first.dispute_id);
  }, [openId, loaded]);

  // a new case: Parley says his line, and the chat (if any) is told
  useEffect(() => {
    if (!openId) return;
    const c = cases.find((x) => x.dispute_id === openId);
    if (c) setSpeech((s) => ({ text: line(c, !!info?.llm?.online), seq: (s?.seq ?? 0) + 1 }));
    window.dispatchEvent(new CustomEvent("parley:case-changed", { detail: { id: openId } }));
  }, [openId, loaded, info?.llm?.online]);

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

  const onWritten = useCallback(async () => {
    await activity.reload();
    await reload().catch(() => {});
  }, [activity.reload, reload]);
  const env = info ? (info.paypalEnv === "mock" ? "PayPal Mock" : "PayPal Sandbox") : null;

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
            <h1>Parley</h1>
            <small>your dispute desk</small>
            {env && <span className="tag">{env}</span>}
          </div>
          <div className="btns">
            <button type="button" className="chip" onClick={() => setTucked(!tucked)}>
              {tucked ? "Bring Parley back" : "Tuck Parley away"}
            </button>
          </div>
        </header>
        <Tiles cases={cases} />
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
              />
            )
          )}
        </section>
        <AllCases cases={cases} onOpen={openCase} onReload={reload} />
        <PayPalFooter calls={activity.calls} failed={failure} />
      </div>
      <Owl speech={speech} tucked={tucked} />
    </>
  );
}

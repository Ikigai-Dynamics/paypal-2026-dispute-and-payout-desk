import { useCallback, useEffect, useState } from "react";
import { useActivity } from "./hooks/useActivity";
import { useCases } from "./hooks/useCases";
import { useInfo } from "./hooks/useInfo";
import { AllCases } from "./components/AllCases";
import { CaseCards } from "./components/CaseCards";
import { DeadlinesTimeline } from "./components/DeadlinesTimeline";
import { PayPalFooter } from "./components/PayPalFooter";
import { SituationHeader } from "./components/SituationHeader";
import { CasePage } from "./case/CasePage";

// the hash drives opening, so back/forward and reload work
const hashId = () => {
  const m = /^#case=(.+)$/.exec(location.hash);
  try {
    return m ? decodeURIComponent(m[1]!) : null;
  } catch {
    return null;
  }
};

export function App() {
  const info = useInfo();
  const { cases, summary, error, reload } = useCases();
  const activity = useActivity();
  const [openId, setOpenId] = useState<string | null>(hashId);
  const [reopen, setReopen] = useState(0); // bumps when the open case is opened again
  const [aiDrafted, setAiDrafted] = useState(false);
  const aiOn = aiDrafted || !!info?.llm?.online;

  useEffect(() => {
    const onHash = () => setOpenId(hashId());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const openCase = useCallback((id: string) => {
    if (location.hash === `#case=${encodeURIComponent(id)}`) setReopen((n) => n + 1);
    else location.hash = `case=${encodeURIComponent(id)}`;
  }, []);
  const closeCase = useCallback(() => {
    setOpenId(null);
    if (location.hash)
      history.pushState(null, "", location.pathname + location.search);
  }, []);
  const onWritten = useCallback(async () => {
    await activity.reload();
    await reload().catch(() => {});
  }, [activity.reload, reload]);

  return (
    <>
      {info?.sync?.error && (
        <div className="banner warn">
          PayPal is unreachable right now: showing the last synced cases.
        </div>
      )}
      <SituationHeader
        info={info}
        aiOn={aiOn}
        cases={cases}
        summary={summary}
        loadError={error}
        onOpen={openCase}
      />
      {openId && (
        <CasePage
          key={openId + ":" + reopen}
          id={openId}
          cases={cases}
          onClose={closeCase}
          onWritten={onWritten}
          onAiDraft={() => setAiDrafted(true)}
        />
      )}
      <CaseCards cases={cases} onOpen={openCase} />
      <DeadlinesTimeline cases={cases} onOpen={openCase} />
      <AllCases cases={cases} summary={summary} onOpen={openCase} onReload={reload} />
      <PayPalFooter calls={activity.calls} />
    </>
  );
}

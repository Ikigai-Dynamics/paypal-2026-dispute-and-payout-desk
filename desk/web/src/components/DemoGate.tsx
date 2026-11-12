import { useEffect, useState } from "react";
import { api, post, ApiError } from "../lib/api";

type Session = { enabled: boolean; active?: boolean; ends_at?: string | null; minutes?: number };

/** The public demo's 10-minute session: a countdown while it runs, a start screen before and after. */
export function DemoGate() {
  const [s, setS] = useState<Session | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Session>("/api/demo/session").then(setS, () => setS({ enabled: false }));
  }, []);
  useEffect(() => {
    if (!s?.active || !s.ends_at) return;
    const end = Date.parse(s.ends_at);
    const tick = () => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [s]);

  if (!s?.enabled) return null;
  const over = !s.active || left === 0;
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post("/api/demo/start", {});
      location.reload(); // every panel loads again with the new session
    } catch (e) {
      setErr(e instanceof ApiError ? (e.body?.detail ?? "Could not start a demo.") : "Could not start a demo.");
      setBusy(false);
    }
  };

  if (!over)
    return (
      <div className="demo-timer" role="timer" aria-label="Time left in this demo">
        Demo: {Math.floor((left ?? 0) / 60)}:{String((left ?? 0) % 60).padStart(2, "0")} left
      </div>
    );
  const ended = s.active || left === 0;
  return (
    <div className="demo-gate" role="dialog" aria-modal="true" aria-labelledby="demo-gate-h">
      <div className="demo-gate-card">
        <h2 id="demo-gate-h">{ended ? "Your demo time is up" : `Start your ${s.minutes ?? 10}-minute demo`}</h2>
        <p>
          Parley runs on a simulated PayPal account with 60 sample disputes. Each visit gets {s.minutes ?? 10} minutes;
          nothing you do reaches a real PayPal account.
        </p>
        <button type="button" className="btn" onClick={start} disabled={busy} autoFocus>
          {ended ? "Start a new demo" : "Start the demo"}
        </button>
        {err && <p className="errbox">{err}</p>}
        <p>
          <a href="/">Back to the Parley home page</a>
        </p>
      </div>
    </div>
  );
}

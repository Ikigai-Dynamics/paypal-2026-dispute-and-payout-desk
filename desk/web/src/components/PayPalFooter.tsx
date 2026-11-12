import { useEffect, useRef, useState } from "react";
import type { ActivityCall } from "../lib/api";
import type { Info } from "../lib/api";
import { money } from "../lib/format";
import "./trust.css";

const ago = (iso: string) => {
  const t = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return t < 60
    ? `${t} s ago`
    : t < 3600
      ? `${Math.round(t / 60)} min ago`
      : `${Math.round(t / 3600)} h ago`;
};
// a plain verb: the last path segment that is not an id
const verb = (p: string) => {
  const seg = String(p).split("?")[0]!.split("/").filter(Boolean);
  while (seg.length > 1 && /\d/.test(seg.at(-1)!)) seg.pop();
  return seg.at(-1) ?? "";
};
const amt = (x: ActivityCall) =>
  x.amount_cents != null ? ` · ${money(x.amount_cents, x.currency || "USD")}` : "";
export const callLabel = (x: ActivityCall) => {
  const v = verb(x.path);
  const via = ` · PayPal ${v}`;
  if (x.buyer && x.amount_cents != null && v === "make-offer")
    return `Offered ${money(x.amount_cents, x.currency || "USD")} to ${x.buyer}${via}`;
  if (x.buyer && x.amount_cents != null && v === "accept-claim")
    return `Refunded ${money(x.amount_cents, x.currency || "USD")} to ${x.buyer}${via}`;
  if (x.buyer && v === "provide-evidence") return `Sent evidence for ${x.buyer}${via}`;
  return x.method === "GET" && !x.buyer && v === "disputes"
    ? "GET disputes (list)"
    : x.method === "GET" && x.buyer
      ? `GET dispute · ${x.buyer}${amt(x)}`
      : x.buyer
        ? `${x.method} ${v} · ${x.buyer}${amt(x)}`
        : `${x.method} ${v}`;
};

const Dot = ({ st }: { st: number }) => (
  <i className={"sdot " + (st < 300 ? "ok" : st < 400 ? "" : "bad")}></i>
);
const Row = ({ x }: { x: ActivityCall }) => (
  <li>
    {callLabel(x)} ·{" "}
    <span className={x.status < 400 ? "s-ok" : "s-bad"}>{x.status}</span> ·{" "}
    {x.ms} ms · {ago(x.at)}
  </li>
);

/** the fixed PayPal call log; hidden while the log is unreachable */
export function PayPalFooter({
  calls,
  failed,
  info,
}: {
  calls: ActivityCall[] | null;
  failed?: { status: number } | null;
  info?: Info | null;
}) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const [pin, setPin] = useState<{ text: string; until: number } | null>(null);
  const lastCall = useRef<string | null>(null);
  const seenPosts = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!calls) return;
    const newest = calls[0]?.at ?? null;
    if (lastCall.current !== null && newest && newest !== lastCall.current) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 2000);
      return () => clearTimeout(t);
    }
    lastCall.current = newest ?? "";
  }, [calls]);
  useEffect(() => {
    if (calls) lastCall.current = calls[0]?.at ?? "";
  }, [calls]);

  // a write that was not in the log before is pinned for 30 s
  useEffect(() => {
    if (!calls) return;
    const posts = calls.filter((x) => x.method === "POST");
    if (seenPosts.current) {
      const w = posts.find((x) => x.status < 300 && !seenPosts.current!.has(x.at));
      if (w) setPin({ text: `Sent to PayPal: ${callLabel(w)} · ${w.status}`, until: Date.now() + 30000 });
    }
    seenPosts.current = new Set(posts.map((x) => x.at));
  }, [calls]);
  useEffect(() => {
    if (!pin) return;
    const t = setTimeout(() => setPin(null), pin.until - Date.now() + 100);
    return () => clearTimeout(t);
  }, [pin]);

  if (!calls && !failed) return null;
  const list = calls ?? [];
  const x = list[0];
  const posts = list.filter((x) => x.method === "POST");
  const gets = new Map<string, { n: number; x: ActivityCall }>();
  for (const g of list.filter((x) => x.method !== "POST")) {
    const k = `${g.method} ${verb(g.path)}`;
    gets.set(k, { n: (gets.get(k)?.n ?? 0) + 1, x: gets.get(k)?.x ?? g });
  }
  const rows = [
    ...posts.map((p) => <Row key={p.at + p.path} x={p} />),
    ...[...gets].map(([k, { n, x }]) =>
      n > 1 ? (
        <li key={k}>
          {k} ×{n} · last {ago(x.at)}
        </li>
      ) : (
        <Row key={k} x={x} />
      ),
    ),
  ].slice(0, 8);
  const last = failed ? (
    <>
      <Dot st={failed.status || 599} />
      <span className="s-bad">
        Last call: GET cases (list) · {failed.status || "no response"} · failed
      </span>
    </>
  ) : pin && Date.now() < pin.until ? (
    <>
      <Dot st={200} />
      {pin.text}
    </>
  ) : x ? (
    <>
      <Dot st={x.status} />
      {callLabel(x)} · {x.status} · {ago(x.at)}
    </>
  ) : (
    "PayPal calls: none yet"
  );
  const ai = info?.llm;
  const synced = info?.sync?.lastOk;
  return (
    <footer className={"activity" + (flash ? " flash" : "")}>
      <div className="statusbar">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="activity-list"
          onClick={() => setOpen(!open)}
        >
          {info && (
            <>
              <span className="seg">
                {info.paypalEnv === "mock" ? "PayPal sandbox (simulated)" : "PayPal sandbox"}
              </span>
              <span className="seg">
                {ai?.online
                  ? `AI: on · $${(ai.costUsd ?? 0).toFixed(2)} so far`
                  : "AI: off (using saved wording)"}
              </span>
              {info.decide && (
                <span className="seg">
                  Decision core: {info.decide.reachable ? "healthy" : "not answering"}
                </span>
              )}
              {synced && <span className="seg">Last sync {ago(synced)}</span>}
            </>
          )}
          <span className="seg last">{last}</span>
          <span className="chev" aria-hidden="true">
            &#9650;
          </span>
        </button>
        <a className="chip" href="/api/activity?format=csv" download>
          Download log (CSV)
        </a>
      </div>
      {open && <ul id="activity-list">{rows}</ul>}
    </footer>
  );
}

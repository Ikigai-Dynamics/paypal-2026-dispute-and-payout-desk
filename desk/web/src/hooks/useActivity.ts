import { useCallback, useEffect, useState } from "react";
import type { ActivityCall } from "../lib/api";

/** the PayPal call log, newest first; refreshed every 5 s while the tab is visible */
export function useActivity() {
  const [calls, setCalls] = useState<ActivityCall[] | null>(null); // null = unreachable
  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/paypal-activity");
      if (!r.ok) throw 0;
      const list = ((await r.json()).calls as ActivityCall[]).sort(
        (a, b) => Date.parse(b.at) - Date.parse(a.at),
      );
      setCalls(list);
    } catch {
      setCalls(null);
    }
  }, []);
  useEffect(() => {
    reload();
    const t = setInterval(
      () => document.visibilityState === "visible" && reload(),
      5000,
    );
    return () => clearInterval(t);
  }, [reload]);
  return { calls, reload };
}

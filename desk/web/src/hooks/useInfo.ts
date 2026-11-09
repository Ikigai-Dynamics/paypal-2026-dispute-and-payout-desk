import { useEffect, useState } from "react";
import { api, type Info } from "../lib/api";

/** GET /api/info, then every 15 s; null until it answers (or if it never does) */
export function useInfo() {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    const load = () => api<Info>("/api/info").then(setInfo, () => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  return info;
}

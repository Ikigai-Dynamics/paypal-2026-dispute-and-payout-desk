import { useEffect, useState } from "react";
import { api, type Info } from "../lib/api";

/** GET /api/info once; null until it answers (or if it never does) */
export function useInfo() {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    api<Info>("/api/info").then(setInfo, () => {});
  }, []);
  return info;
}

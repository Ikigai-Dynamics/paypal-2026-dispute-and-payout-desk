// shortcut: per-pod log, a shared store if replicas diverge visibly
export interface Call {
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
}

const MAX = 50;
const calls: Call[] = [];

export function record(c: Omit<Call, "at"> & { at?: string }): void {
  calls.push({ at: c.at ?? new Date().toISOString(), ...c });
  if (calls.length > MAX) calls.shift();
}

/** Newest first. */
export function list(limit = 20): Call[] {
  return calls.slice(-limit).reverse();
}

export function clear(): void {
  calls.length = 0;
}

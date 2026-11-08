import type pg from "pg";

export interface Call {
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  dispute_id: string | null;
  buyer: string | null;
  amount_cents: number | null;
  currency: string | null;
}

const KEEP = 200;
let pool: pg.Pool | undefined;

/** The log lives in Postgres (table paypal_calls, made by PgStore.ensureSchema) so every pod shows the same list. */
export function init(p: pg.Pool): void {
  pool = p;
}

/** Fire and forget: a failed write is logged, never thrown. */
export function record(
  c: Pick<Call, "method" | "path" | "status" | "ms">,
): void {
  if (!pool) return;
  const p = pool;
  void p
    .query(
      "insert into paypal_calls (method, path, status, ms) values ($1,$2,$3,$4)",
      [c.method, c.path, c.status, c.ms],
    )
    .then(() =>
      p.query(
        "delete from paypal_calls where id <= (select id from paypal_calls order by id desc offset $1 limit 1)",
        [KEEP],
      ),
    )
    .catch((e) =>
      process.stdout.write(
        `${JSON.stringify({ msg: "activity write failed", error: String(e) })}\n`,
      ),
    );
}

/** The dispute a call is about, only when its path names one: the list call has none. */
export const disputeIdOf = (path: string): string | null =>
  /\/v1\/customer\/disputes\/([^/?]+)/.exec(path)?.[1] ?? null;

/** Newest first. Buyer and amount are joined on the exact dispute id in the path. */
export async function list(limit = 20): Promise<Call[]> {
  if (!pool) return [];
  const r = await pool.query(
    "select at, method, path, status, ms from paypal_calls order by id desc limit $1",
    [limit],
  );
  const ids = [...new Set(r.rows.map((x) => disputeIdOf(x.path)))].filter(
    (x): x is string => x !== null,
  );
  const cases = ids.length
    ? await pool.query(
        "select dispute_id, buyer, amount_cents::float8 as amount_cents, currency from cases where dispute_id = any($1::text[])",
        [ids],
      )
    : { rows: [] };
  const byId = new Map(cases.rows.map((c) => [c.dispute_id as string, c]));
  return r.rows.map((x) => {
    const id = disputeIdOf(x.path);
    const c = id ? byId.get(id) : undefined;
    return {
      at: new Date(x.at).toISOString(),
      method: x.method,
      path: x.path,
      status: Number(x.status),
      ms: Number(x.ms),
      dispute_id: c ? id : null,
      buyer: c?.buyer ?? null,
      amount_cents: c ? Number(c.amount_cents) : null,
      currency: c?.currency ?? null,
    };
  });
}

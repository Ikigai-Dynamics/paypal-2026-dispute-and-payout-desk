import type pg from "pg";

export interface Call {
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
}

const KEEP = 200;
let pool: pg.Pool | undefined;

/** The log lives in Postgres (table paypal_calls, made by PgStore.ensureSchema) so every pod shows the same list. */
export function init(p: pg.Pool): void {
  pool = p;
}

/** Fire and forget: a failed write is logged, never thrown. */
export function record(c: Omit<Call, "at">): void {
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

/** Newest first. */
export async function list(limit = 20): Promise<Call[]> {
  if (!pool) return [];
  const r = await pool.query(
    "select at, method, path, status, ms from paypal_calls order by id desc limit $1",
    [limit],
  );
  return r.rows.map((x) => ({
    at: new Date(x.at).toISOString(),
    method: x.method,
    path: x.path,
    status: Number(x.status),
    ms: Number(x.ms),
  }));
}

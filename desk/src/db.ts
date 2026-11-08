import type pg from "pg";
import type { CaseRow } from "./types.js";

/** The one stored and returned shape of evidence the merchant added. */
export interface AddedEv {
  item: string;
  evidence_type: string;
  notes: string;
  tracking?: { carrier: string; number: string };
}

const SCHEMA = [
  `create table if not exists cases (
    dispute_id text primary key, reason text, stage text, status text, outcome text,
    amount_cents bigint, currency text, buyer text, due_at timestamptz, created_at timestamptz, updated_at timestamptz,
    evidence_on_file boolean, raw jsonb not null,
    doc tsvector generated always as (to_tsvector('english',
       coalesce(reason,'') || ' ' || coalesce(raw->>'search_text',''))) stored)`,
  `create index if not exists cases_doc on cases using gin(doc)`,
  `create table if not exists paypal_calls (
    id bigserial primary key, at timestamptz not null default now(),
    method text, path text, status int, ms int)`,
  `create table if not exists case_work (dispute_id text primary key, added jsonb not null default '[]', draft_text text, draft_label text, edited boolean not null default false, updated_at timestamptz not null default now())`,
  `alter table case_work add column if not exists draft_source text`,
  `create table if not exists case_sent (id bigserial primary key, dispute_id text not null, at timestamptz not null default now(), text text not null, added jsonb not null default '[]', vouched jsonb not null default '[]')`,
];

export interface CaseWork {
  added: AddedEv[];
  draft_text: string | null;
  draft_label: string | null;
  draft_source: "llm" | "fallback" | null;
  edited: boolean;
  updated_at: string;
}
export interface CaseSent {
  at: string;
  text: string;
  added: AddedEv[];
  vouched: string[];
}

export interface SearchHit {
  dispute_id: string;
  reason: string;
  status: string;
  amount_cents: number;
  currency: string;
  rank: number;
  snippet: string;
}

export interface PrecedentRow {
  dispute_id: string;
  outcome: string;
  amount_cents: number;
  snippet: string;
  /** the whole search text, so a snippet can be cut at sentence starts */
  text: string;
}

const COLS =
  "dispute_id, reason, stage, status, outcome, amount_cents::float8 as amount_cents, currency, buyer, due_at, created_at, updated_at, evidence_on_file, raw";

function fromDb(r: Record<string, unknown>): CaseRow {
  const iso = (v: unknown) =>
    v ? new Date(v as string | Date).toISOString() : null;
  return {
    dispute_id: r["dispute_id"] as string,
    reason: r["reason"] as string,
    stage: r["stage"] as string,
    status: r["status"] as string,
    outcome: (r["outcome"] as string | null) ?? null,
    amount_cents: Number(r["amount_cents"]),
    currency: r["currency"] as string,
    buyer: r["buyer"] as string,
    due_at: iso(r["due_at"]),
    created_at: iso(r["created_at"]) ?? "",
    updated_at: iso(r["updated_at"]) ?? "",
    evidence_on_file: Boolean(r["evidence_on_file"]),
    raw: r["raw"] as CaseRow["raw"],
  };
}

/** Postgres is an index over PayPal's data, with full-text search (tsvector, no Elastic). */
export class PgStore {
  constructor(private pool: pg.Pool) {}

  async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // two replicas start together; serialise DDL
      await client.query("select pg_advisory_lock(7420001)");
      try {
        for (const s of SCHEMA) await client.query(s);
      } finally {
        await client.query("select pg_advisory_unlock(7420001)");
      }
    } finally {
      client.release();
    }
  }

  async upsert(r: CaseRow): Promise<void> {
    await this.pool.query(
      `insert into cases (dispute_id, reason, stage, status, outcome, amount_cents, currency, buyer, due_at, created_at, updated_at, evidence_on_file, raw)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (dispute_id) do update set reason=excluded.reason, stage=excluded.stage, status=excluded.status,
         outcome=excluded.outcome, amount_cents=excluded.amount_cents, currency=excluded.currency, buyer=excluded.buyer,
         due_at=excluded.due_at, created_at=excluded.created_at, updated_at=excluded.updated_at,
         evidence_on_file=excluded.evidence_on_file, raw=excluded.raw`,
      [
        r.dispute_id,
        r.reason,
        r.stage,
        r.status,
        r.outcome,
        r.amount_cents,
        r.currency,
        r.buyer,
        r.due_at,
        r.created_at,
        r.updated_at,
        r.evidence_on_file,
        JSON.stringify(r.raw),
      ],
    );
  }

  async retainOnly(ids: string[]): Promise<void> {
    await this.pool.query(
      "delete from cases where dispute_id <> all($1::text[])",
      [ids],
    );
  }

  async get(id: string): Promise<CaseRow | undefined> {
    const r = await this.pool.query(
      `select ${COLS} from cases where dispute_id=$1`,
      [id],
    );
    return r.rows[0] ? fromDb(r.rows[0]) : undefined;
  }

  async list(): Promise<CaseRow[]> {
    const r = await this.pool.query(
      `select ${COLS} from cases order by due_at nulls last, dispute_id`,
    );
    return r.rows.map(fromDb);
  }

  /** Other cases of the same buyer name, for the order history shown as evidence. */
  async byBuyer(buyer: string, excludeId: string): Promise<CaseRow[]> {
    const r = await this.pool.query(
      `select ${COLS} from cases where buyer=$1 and dispute_id <> $2`,
      [buyer, excludeId],
    );
    return r.rows.map(fromDb);
  }

  async count(): Promise<number> {
    const r = await this.pool.query("select count(*)::int as n from cases");
    return Number(r.rows[0]?.n ?? 0);
  }

  /** Postgres full-text: websearch_to_tsquery, ts_rank, ts_headline. Top 20. */
  async search(q: string): Promise<SearchHit[]> {
    const r = await this.pool.query(
      `select dispute_id, reason, status, amount_cents::float8 as amount_cents, currency, ts_rank(doc, query) as rank,
              ts_headline('english', coalesce(raw->>'search_text',''), query,
                'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MaxWords=18,MinWords=6') as snippet
       from cases, websearch_to_tsquery('english', $1) query
       where doc @@ query
       order by rank desc, dispute_id
       limit 20`,
      [q],
    );
    return r.rows.map((x) => ({
      dispute_id: x.dispute_id,
      reason: x.reason,
      status: x.status,
      amount_cents: Number(x.amount_cents),
      currency: x.currency,
      rank: Number(x.rank),
      snippet: String(x.snippet),
    }));
  }

  /** Resolved cases with the same reason, ranked by full-text similarity (OR of the case's top terms). */
  async precedents(
    reason: string,
    excludeId: string,
    tsquery: string,
    limit = 8,
  ): Promise<PrecedentRow[]> {
    const r = await this.pool.query(
      `select dispute_id, outcome, amount_cents::float8 as amount_cents,
              ts_rank(doc, query) as rank, coalesce(raw->>'search_text','') as text,
              ts_headline('english', coalesce(raw->>'search_text',''), query,
                'StartSel="",StopSel="",MaxFragments=1,MaxWords=16,MinWords=6') as snippet
       from cases, to_tsquery('english', $3) query
       where reason = $1 and status = 'RESOLVED' and outcome is not null and dispute_id <> $2
       order by rank desc, dispute_id
       limit $4`,
      [reason, excludeId, tsquery, limit],
    );
    return r.rows.map((x) => ({
      dispute_id: x.dispute_id,
      outcome: x.outcome,
      amount_cents: Number(x.amount_cents),
      snippet: String(x.snippet),
      text: String(x.text),
    }));
  }

  async getWork(id: string): Promise<CaseWork | null> {
    const r = await this.pool.query(
      "select added, draft_text, draft_label, draft_source, edited, updated_at from case_work where dispute_id=$1",
      [id],
    );
    const x = r.rows[0];
    return x
      ? {
          added: x.added as AddedEv[],
          draft_text: x.draft_text ?? null,
          draft_label: x.draft_label ?? null,
          draft_source: x.draft_source ?? null,
          edited: Boolean(x.edited),
          updated_at: new Date(x.updated_at).toISOString(),
        }
      : null;
  }

  /** Upsert; a field left undefined keeps its saved value. `label: null` clears the label. */
  async putWork(
    id: string,
    w: {
      added?: AddedEv[];
      text?: string;
      label?: string | null;
      source?: "llm" | "fallback";
      edited?: boolean;
    },
  ): Promise<CaseWork> {
    await this.pool.query(
      `insert into case_work (dispute_id, added, draft_text, draft_label, edited, draft_source)
       values ($1, coalesce($2::jsonb,'[]'::jsonb), $3, $4, coalesce($5,false), $7)
       on conflict (dispute_id) do update set
         added = coalesce($2::jsonb, case_work.added),
         draft_text = coalesce($3, case_work.draft_text),
         draft_label = case when $6 then $4 else case_work.draft_label end,
         edited = coalesce($5, case_work.edited),
         draft_source = coalesce($7, case_work.draft_source),
         updated_at = now()`,
      [
        id,
        w.added ? JSON.stringify(w.added) : null,
        w.text ?? null,
        w.label ?? null,
        w.edited ?? null,
        w.label !== undefined,
        w.source ?? null,
      ],
    );
    return (await this.getWork(id))!;
  }

  async deleteWork(id: string): Promise<void> {
    await this.pool.query("delete from case_work where dispute_id=$1", [id]);
  }

  async recordSent(
    id: string,
    text: string,
    added: AddedEv[],
    vouched: string[],
  ): Promise<void> {
    await this.pool.query(
      "insert into case_sent (dispute_id, text, added, vouched) values ($1,$2,$3::jsonb,$4::jsonb)",
      [id, text, JSON.stringify(added), JSON.stringify(vouched)],
    );
  }

  async getSent(id: string): Promise<CaseSent | null> {
    const r = await this.pool.query(
      "select at, text, added, vouched from case_sent where dispute_id=$1 order by id desc limit 1",
      [id],
    );
    const x = r.rows[0];
    return x
      ? {
          at: new Date(x.at).toISOString(),
          text: x.text,
          added: x.added as AddedEv[],
          vouched: x.vouched as string[],
        }
      : null;
  }

  async resetWork(): Promise<void> {
    await this.pool.query("truncate case_work, case_sent, paypal_calls");
  }
}

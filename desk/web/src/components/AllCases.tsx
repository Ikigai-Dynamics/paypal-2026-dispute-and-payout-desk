import { useMemo, useRef, useState, type FormEvent } from "react";
import {
  AllCommunityModule,
  ModuleRegistry,
  type ColDef,
  type GridApi,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { api, download, post, type CaseSummary } from "../lib/api";
import "./trust.css";
import {
  dateShort,
  money,
  needsResponse,
  reasonShort,
  reasonWords,
  callKind,
  callWords,
  statusWords,
} from "../lib/format";

ModuleRegistry.registerModules([AllCommunityModule]);

const GRID_ROW = 36;
type Hit = {
  dispute_id: string;
  status: string;
  amount_cents: number;
  currency: string;
  snippet: string;
};

const columns: ColDef<CaseSummary>[] = [
  { field: "buyer", headerName: "Buyer", flex: 1, minWidth: 130 },
  {
    headerName: "Reason",
    flex: 1.2,
    minWidth: 160,
    valueGetter: (p) => reasonShort(p.data!.reason),
    tooltipValueGetter: (p) => reasonWords(p.data!.reason),
  },
  {
    field: "amount_cents",
    headerName: "Amount",
    width: 120,
    valueFormatter: (p) => money(p.value, p.data!.currency),
  },
  {
    field: "due_at",
    headerName: "Due",
    width: 100,
    sort: "asc",
    comparator: (a, b, _x, _y, desc) =>
      a == null
        ? b == null
          ? 0
          : desc
            ? -1
            : 1
        : b == null
          ? desc
            ? 1
            : -1
          : Date.parse(a) - Date.parse(b),
    valueFormatter: (p) => (p.value ? dateShort(p.value) : ""),
  },
  {
    headerName: "Parley's call",
    width: 170,
    valueGetter: (p) =>
      p.data!.call || needsResponse(p.data!) ? callWords(p.data!) : "—",
    cellClass: (p) => "cell-" + (callKind(p.data!.call) ?? "none"),
  },
  {
    headerName: "Status",
    flex: 1,
    minWidth: 160,
    valueGetter: (p) => statusWords(p.data!),
  },
  { field: "dispute_id", headerName: "Case id", width: 160, hide: true }, // kept for search
];

// ts_headline marks hits with <mark>; render them as elements, not markup
const Snippet = ({ text }: { text: string }) => (
  <>
    {text.split(/<\/?mark>/).map((s, i) =>
      i % 2 ? <mark key={i}>{s}</mark> : <span key={i}>{s}</span>,
    )}
  </>
);

export function AllCases({
  cases,
  onOpen,
  onReload,
}: {
  cases: CaseSummary[];
  onOpen(id: string): void;
  onReload(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [shown, setShown] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const grid = useRef<GridApi<CaseSummary> | null>(null);
  const byId = useMemo(() => new Map(cases.map((c) => [c.dispute_id, c])), [cases]);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    const s = q.trim();
    if (!s) return setHits(null);
    setOpen(true);
    try {
      const r = await api<{ hits: Hit[] }>(`/api/search?q=${encodeURIComponent(s)}`);
      setHits(r.hits);
    } catch {
      alert("Search is not available right now. Try again.");
    }
  };
  const sync = async () => {
    setSyncing(true);
    try {
      await post("/api/sync", {});
      await onReload();
    } catch {
      alert("Could not refresh from PayPal. Try again.");
    }
    setSyncing(false);
  };
  // height follows the rows, up to 15
  const rows = Math.min(15, Math.max(1, shown));
  return (
    <details
      className="card alld"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        All disputes ({cases.length})
      </summary>
      <section className="bar">
        <form onSubmit={search}>
          <input
            type="search"
            aria-label="Search cases"
            placeholder="Search cases: buyer, item, tracking…"
            size={44}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              if (!e.target.value.trim()) setHits(null);
            }}
          />
        </form>
        <div className="btns">
          <button type="button" className="chip" disabled={syncing} onClick={sync}>
            {syncing ? "Refreshing…" : "Refresh from PayPal"}
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => grid.current?.exportDataAsCsv({ fileName: "parley-disputes.csv" })}
          >
            Export CSV
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => download("parley-disputes.json", JSON.stringify(cases, null, 2), "application/json")}
          >
            Export JSON
          </button>
        </div>
      </section>
      {hits && (
        <section id="results">
          <div className="muted">
            {hits.length} past case{hits.length === 1 ? "" : "s"} found
          </div>
          {hits.map((h) => {
            const c = byId.get(h.dispute_id);
            return (
              <div key={h.dispute_id} className="hit" onClick={() => onOpen(h.dispute_id)}>
                <b>{c?.buyer ?? "Case " + h.dispute_id}</b> ·{" "}
                {money(h.amount_cents, h.currency)} · {statusWords(c ?? h)}
                <br />
                <Snippet text={h.snippet} />
              </div>
            );
          })}
        </section>
      )}
      <div className="grid" style={{ height: `${(rows + 1) * GRID_ROW + 4}px` }}>
        <AgGridReact<CaseSummary>
          columnDefs={columns}
          rowData={cases}
          getRowId={(p) => p.data.dispute_id}
          rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
          onRowClicked={(e) => e.data && onOpen(e.data.dispute_id)}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          includeHiddenColumnsInQuickFilter
          suppressNoRowsOverlay
          quickFilterText={q}
          rowHeight={GRID_ROW}
          headerHeight={GRID_ROW}
          onGridReady={(e) => (grid.current = e.api)}
          onModelUpdated={(e) => setShown(e.api.getDisplayedRowCount())}
        />
      </div>
      {shown === 0 && cases.length > 0 && <p className="muted">No cases match</p>}
    </details>
  );
}

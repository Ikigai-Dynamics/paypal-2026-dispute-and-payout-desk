const $ = (id) => document.getElementById(id);
const usd = (cents, cur = "USD") => `${(cents / 100).toFixed(2)} ${cur}`;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok)
    throw Object.assign(new Error(body.detail || body.error || r.status), {
      status: r.status,
      body,
    });
  return body;
};
const post = (path, data) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });

let gridApi;
let current = null; // dispute id in the panel
let currentAnalysis = null;

function callClass(call) {
  if (!call) return "unknown";
  if (call.includes("marginal")) return "marginal";
  return call;
}

const columns = [
  { field: "dispute_id", headerName: "Case", width: 170 },
  {
    field: "reason",
    headerName: "Reason",
    filter: "agSetColumnFilter",
    minWidth: 250,
    valueFormatter: (p) => String(p.value).replaceAll("_", " ").toLowerCase(),
  },
  { field: "stage", headerName: "Stage", width: 130 },
  {
    field: "status",
    headerName: "Status",
    filter: "agSetColumnFilter",
    width: 220,
  },
  {
    field: "amount_cents",
    headerName: "Amount",
    width: 120,
    valueFormatter: (p) => usd(p.value, p.data.currency),
  },
  {
    field: "days_left",
    headerName: "Days left",
    width: 110,
    sort: "asc",
    comparator: (a, b) => (a ?? 1e9) - (b ?? 1e9),
    cellClass: (p) => (p.value !== null && p.value < 3 ? "red" : ""),
    valueFormatter: (p) => (p.value === null ? "" : p.value.toFixed(1)),
  },
  {
    field: "evidence_on_file",
    headerName: "Evidence on file",
    width: 140,
    valueFormatter: (p) => (p.value ? "yes" : "no"),
  },
  {
    field: "call",
    headerName: "Call",
    width: 140,
    valueFormatter: (p) => p.value ?? "(open for call)",
  },
];

function setupGrid() {
  const opts = {
    columnDefs: columns,
    rowData: [],
    getRowId: (p) => p.data.dispute_id,
    rowSelection: {
      mode: "singleRow",
      checkboxes: false,
      enableClickSelection: true,
    },
    onRowClicked: (e) => openCase(e.data.dispute_id),
    defaultColDef: { sortable: true, resizable: true, filter: true },
  };
  // v36 exports createGrid on the agGrid global; the set filter is Enterprise, so fall back to text filters.
  const hasSet = !!(window.agGrid && agGrid.SetFilterModule);
  if (!hasSet)
    for (const c of columns)
      if (c.filter === "agSetColumnFilter") c.filter = "agTextColumnFilter";
  gridApi = agGrid.createGrid($("grid"), opts);
}

async function loadCases() {
  const { cases } = await api("/api/cases");
  gridApi.setGridOption("rowData", cases);
  renderTimeline(cases);
}

function renderTimeline(cases) {
  const el = $("timeline");
  el.innerHTML = '<div class="axis"></div>';
  const now = Date.now();
  const span = 21 * 86400000;
  for (let d = 0; d <= 21; d += d < 7 ? 1 : 7) {
    const t = document.createElement("div");
    t.className = "tick" + (d % 7 === 0 ? " week" : "");
    t.style.left = `${(d / 21) * 96 + 2}%`;
    t.textContent = d === 0 ? "now" : `+${d}d`;
    el.appendChild(t);
  }
  const open = cases.filter(
    (c) => c.due_at && Date.parse(c.due_at) - now <= span,
  );
  const lanes = new Map();
  for (const c of open.sort(
    (a, b) => Date.parse(a.due_at) - Date.parse(b.due_at),
  )) {
    const frac = Math.max(0, (Date.parse(c.due_at) - now) / span);
    const left = frac * 96 + 2;
    const bucket = Math.round(left);
    const lane = lanes.get(bucket) ?? 0;
    lanes.set(bucket, lane + 1);
    const m = document.createElement("div");
    m.className = `marker ${callClass(c.call)}`;
    m.style.left = `${left}%`;
    m.style.top = `${40 - (lane % 3) * 14}px`;
    m.title = `${c.dispute_id}\n${usd(c.amount_cents, c.currency)} due ${c.due_at}\ncall: ${c.call ?? "unknown"}`;
    m.onclick = () => openCase(c.dispute_id);
    el.appendChild(m);
  }
  const lg = document.createElement("div");
  lg.className = "legend muted";
  lg.textContent =
    "Markers at due date for the next 21 days. Green fight, red accept, amber marginal, grey not yet computed.";
  el.appendChild(lg);
}

async function openCase(id) {
  current = id;
  $("panel").hidden = false;
  $("panel-title").textContent = `Case ${id}`;
  $("action-result").textContent = "";
  await recompute();
  $("panel").scrollIntoView({ behavior: "smooth" });
}

async function recompute() {
  if (!current) return;
  const q = new URLSearchParams();
  if ($("in-prior").value.trim()) q.set("prior", $("in-prior").value.trim());
  q.set("c", $("in-c").value || "15");
  q.set("fee", $("in-fee").value || "0");
  $("call").textContent = "...";
  try {
    currentAnalysis = await api(
      `/api/cases/${encodeURIComponent(current)}/analysis?${q}`,
    );
  } catch (e) {
    $("call").textContent = "error";
    $("terms").textContent = e.message;
    return;
  }
  renderAnalysis(currentAnalysis);
}

function renderAnalysis(a) {
  const c = a.case;
  $("facts").innerHTML =
    `<div class="msg">${esc(c.reason.replaceAll("_", " ").toLowerCase())} | ${esc(c.stage)} | ${esc(c.status)}${c.outcome ? " | " + esc(c.outcome) : ""}<br>${esc(usd(c.amount_cents, c.currency))} from ${esc(c.buyer)}${c.due_at ? `<br>seller response due ${esc(c.due_at)} (${c.days_left} days)` : ""}</div>`;
  $("messages").innerHTML =
    c.messages
      .map(
        (m) =>
          `<div class="msg"><b>${esc(m.posted_by)}</b> ${esc(m.content)}</div>`,
      )
      .join("") || "none";
  $("items").innerHTML =
    c.items
      .map(
        (i) =>
          `<div class="msg">${esc(i.item_quantity)} x ${esc(i.item_description)}</div>`,
      )
      .join("") || "none";
  $("evidence").innerHTML =
    c.evidences
      .map((e) => {
        const t = (e.evidence_info?.tracking_info ?? [])
          .map((x) => `${x.carrier_name} ${x.tracking_number}`)
          .join(", ");
        return `<div class="msg"><b>${esc(e.evidence_type)}</b> ${esc(t)} ${esc(e.notes ?? "")}</div>`;
      })
      .join("") || "none on file";
  $("precedents").innerHTML = a.precedents.length
    ? `<table class="prec"><tr><th>Case</th><th>Outcome</th><th>Snippet</th></tr>${a.precedents.map((p) => `<tr><td>${esc(p.dispute_id)}</td><td>${p.won ? "seller won" : "buyer won"}</td><td>${esc(p.snippet)}</td></tr>`).join("")}</table>`
    : "no resolved cases with this reason yet";
  const d = a.decision;
  if (d) {
    const cls = d.marginal ? "marginal" : d.call;
    $("call").className = `call ${cls}`;
    $("call").textContent = d.marginal ? `${d.call} (marginal)` : d.call;
    $("terms").textContent =
      `${d.terms.join("\n")}\n\np0 = ${d.p0} (${d.p0_source}; an assumption)\nprecedents: ${d.wins} won of ${d.n}`;
  } else {
    $("call").className = "call";
    $("call").textContent = "no decision";
    $("terms").textContent =
      "The decision core (decide.v1) is unreachable; the draft below is still available.";
  }
  const dr = a.draft;
  $("draft").value = dr.response;
  $("badge").textContent =
    dr.source === "llm" ? `AI: llm ${dr.model ?? ""}` : "AI: offline fallback";
  $("badge").title = dr.error ?? "";
  $("checklist").innerHTML = dr.checklist
    .map(
      (i) =>
        `<li class="${i.status}"><b>${esc(i.status)}</b> ${esc(i.item)}: ${esc(i.why)}</li>`,
    )
    .join("");
  $("explanation").textContent = dr.explanation;
}

async function act(kind) {
  if (!current || !currentAnalysis) return;
  const c = currentAnalysis.case;
  const amount = usd(c.amount_cents, c.currency);
  const msg =
    kind === "evidence"
      ? `Submit this response as evidence on ${current}? The dispute is for ${amount}.`
      : `Accept the claim on ${current} and refund ${amount} to the buyer?`;
  if (!confirm(msg)) return;
  try {
    if (kind === "evidence")
      await post(`/api/cases/${encodeURIComponent(current)}/evidence`, {
        text: $("draft").value,
        confirm: true,
      });
    else
      await post(`/api/cases/${encodeURIComponent(current)}/accept`, {
        note: "Accepted by the seller from the desk",
        confirm: true,
      });
    $("action-result").textContent =
      kind === "evidence"
        ? "Evidence submitted; case is now under review."
        : "Claim accepted; case resolved in the buyer's favour.";
    await loadCases();
    await recompute();
  } catch (e) {
    $("action-result").textContent =
      `Failed: ${e.message}${e.body?.debug_id ? " (debug_id " + e.body.debug_id + ")" : ""}`;
  }
}

async function search(e) {
  e.preventDefault();
  const q = $("search").value.trim();
  if (!q) {
    $("results").hidden = true;
    return;
  }
  const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
  $("results").hidden = false;
  $("results").innerHTML =
    `<div class="muted">${r.hits.length} hits (${esc(r.engine)}), ranked by ts_rank</div>` +
    r.hits
      .map(
        (h) =>
          `<div class="hit" data-id="${esc(h.dispute_id)}"><b>${esc(h.dispute_id)}</b> ${esc(h.status)} ${esc(usd(h.amount_cents, h.currency))} <span class="muted">rank ${h.rank.toFixed(3)}</span><br>${esc(h.snippet).replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>")}</div>`,
      )
      .join("");
  for (const el of $("results").querySelectorAll(".hit"))
    el.onclick = () => openCase(el.dataset.id);
}

async function init() {
  setupGrid();
  $("search-form").onsubmit = (e) => search(e).catch((x) => alert(x.message));
  $("quick").oninput = (e) =>
    gridApi.setGridOption("quickFilterText", e.target.value);
  $("recompute").onclick = recompute;
  $("submit-evidence").onclick = () => act("evidence");
  $("accept-claim").onclick = () => act("accept");
  $("sync").onclick = async () => {
    $("sync").disabled = true;
    try {
      await post("/api/sync", {});
      await loadCases();
    } catch (e) {
      alert(e.message);
    }
    $("sync").disabled = false;
  };
  const info = await api("/api/info").catch(() => null);
  if (info) {
    $("banner").hidden = info.paypalEnv !== "mock";
    $("unreachable").hidden = !info.sync?.error;
    $("status").textContent =
      `${info.cases ?? "?"} cases | decide ${info.decide.reachable ? "up" : "down"} | AI ${info.llm.online ? "online" : "offline fallback"} | search: ${info.search}`;
  }
  await loadCases();
}
init();

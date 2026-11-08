const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const money = (cents, cur = "USD") => {
  const n = (Math.abs(cents) / 100)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+\.)/g, ",");
  return cur === "USD" ? `$${n}` : `${n} ${cur}`;
};
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok)
    throw Object.assign(new Error(String(r.status)), {
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

const DAY = 86400000;
const REASONS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorised",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  CREDIT_NOT_PROCESSED: "Refund not processed",
  CANCELED_RECURRING_BILLING: "Cancelled subscription",
};
const sentence = (s) => {
  const t = String(s ?? "")
    .replaceAll("_", " ")
    .toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const reasonWords = (r) => REASONS[r] ?? sentence(r);
const needsResponse = (c) =>
  c.status === "WAITING_FOR_SELLER_RESPONSE" || c.status === "OPEN";
const statusWords = (c) => {
  if (needsResponse(c)) return "Needs your response";
  if (c.status === "WAITING_FOR_BUYER_RESPONSE") return "Waiting for buyer";
  if (c.status === "UNDER_REVIEW") return "Under review";
  if (c.status === "RESOLVED" || c.outcome)
    return c.outcome === "RESOLVED_SELLER_FAVOUR"
      ? "Resolved: you won"
      : c.outcome === "RESOLVED_BUYER_FAVOUR"
        ? "Resolved: buyer won"
        : "Resolved";
  return sentence(c.status);
};
// call may be "accept (marginal)"; marginal is also a flag on the decision
function rec(call, marginal) {
  if (!call)
    return {
      kind: "unknown",
      base: null,
      label: "Not yet analysed",
      color: "grey",
    };
  const base = call.startsWith("fight") ? "fight" : "accept";
  const m = marginal ?? call.includes("marginal");
  if (m)
    return {
      kind: "marginal",
      base,
      label: `Close call: ${base}`,
      color: "amber",
    };
  return {
    kind: base,
    base,
    label: base === "fight" ? "Fight" : "Accept",
    color: base === "fight" ? "green" : "red",
  };
}
const dateShort = (iso) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const dateLong = (iso) =>
  new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
const inDays = (iso) => {
  const d = (Date.parse(iso) - Date.now()) / DAY;
  if (d < 0) return "overdue";
  if (d < 1) return "in under a day";
  const n = Math.floor(d);
  return `in ${n} day${n === 1 ? "" : "s"}`;
};

let gridApi;
let allCases = [];
let current = null;
let currentAnalysis = null;
let added = new Map(); // checklist item -> evidence held until submit
let fightAnyway = false;
let sent = null; // success message once a write went through

const columns = [
  { field: "buyer", headerName: "Buyer", flex: 1, minWidth: 130 },
  {
    headerName: "Reason",
    flex: 1.2,
    minWidth: 160,
    valueGetter: (p) => reasonWords(p.data.reason),
  },
  {
    field: "amount_cents",
    headerName: "Amount ($)",
    width: 120,
    valueFormatter: (p) => money(p.value, p.data.currency),
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
    headerName: "Recommendation",
    width: 170,
    valueGetter: (p) => rec(p.data.call).label,
    valueFormatter: (p) => (p.data.call ? p.value : "—"),
    cellClass: (p) => "cell-" + rec(p.data.call).kind,
  },
  {
    headerName: "Status",
    flex: 1,
    minWidth: 160,
    valueGetter: (p) => statusWords(p.data),
  },
  { field: "dispute_id", headerName: "Case id", width: 160 },
];

function setupGrid() {
  gridApi = agGrid.createGrid($("grid"), {
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
  });
}

async function loadCases() {
  const { cases } = await api("/api/cases");
  allCases = cases;
  gridApi.setGridOption("rowData", cases);
  $("all-sum").textContent = `All cases (${cases.length})`;
  renderSituation();
  renderCards();
  renderTimeline(cases);
}

const needing = () =>
  allCases
    .filter(needsResponse)
    .sort(
      (a, b) =>
        (Date.parse(a.due_at) || Infinity) - (Date.parse(b.due_at) || Infinity),
    );

function renderSituation() {
  const n = needing();
  const now = Date.now();
  const soon = n.filter(
    (c) =>
      c.due_at &&
      Date.parse(c.due_at) >= now &&
      Date.parse(c.due_at) - now <= 3 * DAY,
  ).length;
  const total = n.reduce((s, c) => s + c.amount_cents, 0);
  const f = n.filter((c) => rec(c.call).base === "fight").length;
  const a = n.filter((c) => rec(c.call).base === "accept").length;
  $("situation").textContent =
    `${n.length} disputes need your response · ${soon} due in the next 3 days · ${money(total)} at stake · Recommended: fight ${f}, accept ${a}`;
  $("start").disabled = !n.length;
}

let showAll = false;
function renderCards() {
  const n = needing();
  const shown = showAll ? n : n.slice(0, 6);
  $("cards").innerHTML =
    shown
      .map((c) => {
        const r = rec(c.call);
        const late = c.due_at && Date.parse(c.due_at) < Date.now();
        const soon =
          late || (c.due_at && Date.parse(c.due_at) - Date.now() < 3 * DAY);
        const due = c.due_at
          ? `Due ${dateLong(c.due_at)} · ${inDays(c.due_at)}`
          : "No due date";
        return `<div class="dcard" tabindex="0" role="button" data-id="${esc(c.dispute_id)}"><span class="who">${esc(c.buyer)}</span><span class="reason">${esc(reasonWords(c.reason))}</span><span class="amt">${money(c.amount_cents, c.currency)}</span><span class="due${soon ? " soon" : ""}">${esc(due)}</span><span class="pill ${r.color}">${r.label}</span></div>`;
      })
      .join("") ||
    '<p class="muted">Nothing needs your response right now.</p>';
  for (const el of $("cards").querySelectorAll(".dcard")) {
    el.onclick = () => openCase(el.dataset.id);
    el.onkeydown = (e) =>
      (e.key === "Enter" || e.key === " ") &&
      (e.preventDefault(), openCase(el.dataset.id));
  }
  const more = $("show-all");
  more.hidden = n.length <= 6;
  more.textContent = showAll ? "Show fewer" : `Show all ${n.length}`;
}

function renderTimeline(cases) {
  const el = $("timeline");
  el.innerHTML = '<div class="axis"></div>';
  const now = Date.now();
  const span = 21 * DAY;
  for (let d = 0; d <= 21; d += d < 7 ? 1 : 7) {
    const t = document.createElement("div");
    t.className = "tick" + (d % 7 === 0 ? " week" : "");
    t.style.left = `${(d / 21) * 96 + 2}%`;
    t.textContent = d === 0 ? "now" : `+${d}d`;
    el.appendChild(t);
  }
  const lanes = new Map();
  const open = cases.filter(
    (c) => needsResponse(c) && c.due_at && Date.parse(c.due_at) - now <= span,
  );
  for (const c of open.sort(
    (a, b) => Date.parse(a.due_at) - Date.parse(b.due_at),
  )) {
    const left =
      Math.min(1, Math.max(0, (Date.parse(c.due_at) - now) / span)) * 96 + 2;
    const bucket = Math.round(left);
    const lane = lanes.get(bucket) ?? 0;
    lanes.set(bucket, lane + 1);
    const r = rec(c.call);
    const m = document.createElement("div");
    m.className = `marker ${r.kind}`;
    m.style.left = `${left}%`;
    m.style.top = `${40 - (lane % 3) * 14}px`;
    m.title = `${c.buyer} · ${money(c.amount_cents, c.currency)} · due ${dateShort(c.due_at)} · ${r.label}`;
    m.onclick = () => openCase(c.dispute_id);
    el.appendChild(m);
  }
}

async function openCase(id) {
  current = id;
  added = new Map();
  fightAnyway = false;
  sent = null;
  $("panel").hidden = false;
  $("panel-title").textContent = "Loading...";
  $("panel-sub").textContent = "";
  $("action-result").innerHTML = "";
  $("in-prior").value = "";
  $("in-c").value = "15.00";
  $("in-fee").value = "0.00";
  $("draft").value = "";
  await recompute(true);
  $("panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function recompute(fresh) {
  if (!current) return;
  const q = new URLSearchParams();
  const p = $("in-prior").value.trim();
  if (p !== "") {
    const v = Number(p);
    if (!(v >= 0 && v <= 100)) {
      $("panel-error").hidden = false;
      $("panel-error").textContent = "Win chance must be between 0 and 100.";
      return;
    }
    q.set("prior", String(v / 100));
  }
  q.set("c", $("in-c").value || "15");
  q.set("fee", $("in-fee").value || "0");
  try {
    currentAnalysis = await api(
      `/api/cases/${encodeURIComponent(current)}/analysis?${q}`,
    );
    $("panel-error").hidden = true;
  } catch {
    $("panel-error").hidden = false;
    $("panel-error").textContent = "Could not load this case. Try again.";
    return;
  }
  renderAnalysis(currentAnalysis, fresh);
}

const pct = (x) => Math.round(x * 100);
function recSentence(d) {
  const margin = money(Math.abs(d.margin_cents));
  if (d.call === "fight")
    return `${pct(d.p)}% chance of winning, ${d.n > 0 ? `based on ${d.n} similar past case${d.n === 1 ? "" : "s"}` : "based on the typical win rate for this kind of dispute"}; fighting is worth about ${margin} more than refunding.`;
  return `Only ${pct(d.p)}% chance of winning; refunding now saves about ${margin} compared with fighting.`;
}

function renderAnalysis(a, fresh) {
  const c = a.case;
  const amt = money(c.amount_cents, c.currency);
  $("panel-title").textContent =
    `${c.buyer} · ${reasonWords(c.reason)} · ${amt}`;
  $("panel-sub").textContent =
    `Case ${c.dispute_id} · ${c.due_at ? `response due ${dateShort(c.due_at)} (${inDays(c.due_at)})` : "no response deadline"} · ${statusWords(c)}`;
  $("messages").innerHTML =
    c.messages
      .map(
        (m) =>
          `<div class="msg"><b>${m.posted_by === "BUYER" ? "Buyer" : "You"}</b>: ${esc(m.content)}</div>`,
      )
      .join("") || '<p class="muted">No messages.</p>';
  $("items").innerHTML =
    c.items
      .map(
        (i) =>
          `<div class="msg">${esc(i.item_quantity)} × ${esc(i.item_description)}</div>`,
      )
      .join("") || '<p class="muted">No items listed.</p>';
  $("evidence").innerHTML =
    c.evidences
      .map((e) => {
        const t = (e.evidence_info?.tracking_info ?? [])
          .map((x) => `${x.carrier_name} ${x.tracking_number}`)
          .join(", ");
        return `<div class="msg">${t ? `<b>${esc(t)}</b> ` : ""}${esc(e.notes ?? "")}</div>`;
      })
      .join("") || '<p class="muted">Nothing yet</p>';

  const d = a.decision;
  const r = d ? rec(d.call, d.marginal) : null;
  const box = $("rec");
  if (d) {
    box.className = `rec ${r.kind}`;
    box.innerHTML = `<div class="word">${d.marginal ? `Close call — ${d.call}` : d.call === "fight" ? "Fight" : "Accept"}</div><div>${esc(recSentence(d))}</div>`;
    $("terms").textContent = d.terms.join("\n");
    $("p0line").textContent =
      `Starting estimate for this kind of dispute: ${pct(d.p0)}% (an assumption, not PayPal data)`;
  } else {
    box.className = "rec";
    box.innerHTML =
      '<div class="muted">No recommendation is available right now. You can still respond below.</div>';
    $("terms").textContent = "";
    $("p0line").textContent = "";
  }
  $("precedents").innerHTML = a.precedents.length
    ? `<table class="prec"><tr><th>Outcome</th><th>Snippet</th></tr>${a.precedents.map((p) => `<tr><td>${p.won ? "You won" : "Buyer won"}</td><td>${esc(p.snippet)}</td></tr>`).join("")}</table>`
    : '<p class="muted">No similar resolved cases yet.</p>';

  const dr = a.draft;
  if (fresh || !$("draft").value) $("draft").value = dr.response;
  const b = $("badge");
  b.textContent = dr.source === "llm" ? "Drafted by AI" : "Template draft";
  b.className = "pill " + (dr.source === "llm" ? "blue" : "grey");
  $("explanation").textContent = dr.explanation ?? "";
  renderChecklist();
  renderActions();
}

const canAct = () =>
  currentAnalysis && needsResponse(currentAnalysis.case) && !sent;
const isFight = () =>
  !currentAnalysis.decision ||
  currentAnalysis.decision.call === "fight" ||
  fightAnyway;
const missing = () =>
  currentAnalysis.draft.checklist.filter((i) => i.status === "missing");
const stillMissing = () => missing().filter((i) => !added.has(i.item));

function renderChecklist() {
  const a = currentAnalysis;
  const list = a.draft.checklist;
  $("fightbox").hidden = !(isFight() && needsResponse(a.case));
  const miss = stillMissing().length;
  const k = list.length;
  const cc = $("check-count");
  if (!k) cc.hidden = true;
  else {
    cc.hidden = false;
    cc.textContent = miss
      ? `${miss} of ${k} items missing`
      : `All ${k} items ready`;
    cc.className = "pill " + (miss ? "red" : "green");
  }
  const ul = $("checklist");
  ul.innerHTML = "";
  for (const i of list) {
    const li = document.createElement("li");
    const ok = i.status !== "missing";
    const ad = added.get(i.item);
    li.className = ok || ad ? "ok" : "no";
    li.innerHTML = `<span class="ico">${ok || ad ? "✓" : "✗"}</span><b>${esc(i.item)}</b><span class="why">${ad ? "Added — will be sent with your response" : esc(i.why)}</span>`;
    if (ad) {
      const u = document.createElement("a");
      u.href = "#";
      u.textContent = "Undo";
      u.onclick = (e) => (
        e.preventDefault(),
        added.delete(i.item),
        renderChecklist(),
        renderActions()
      );
      li.appendChild(u);
    } else if (!ok) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Add";
      btn.onclick = () => (btn.remove(), li.appendChild(addForm(i)));
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
}

const MAX_FILE = 5 * 1024 * 1024;
const FILE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
};
const readFile = (f) =>
  new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
    fr.onerror = rej;
    fr.readAsDataURL(f);
  });

function addForm(i) {
  const form = document.createElement("form");
  const tracking = i.item === "Tracking number";
  form.innerHTML = tracking
    ? '<div class="row"><label>Carrier<input name="carrier" required></label><label>Tracking number<input name="number" required></label></div>'
    : `<label>Note<textarea name="note" rows="2" required>${esc(i.item)}: </textarea></label><label>File (optional, .png .jpg .pdf, up to 5 MB)<input type="file" name="file" accept=".png,.jpg,.jpeg,.pdf"></label>`;
  form.insertAdjacentHTML(
    "beforeend",
    '<div class="formerr" hidden></div><div class="row"><button class="primary">Save</button><button type="button" class="cancel">Cancel</button></div>',
  );
  form.querySelector(".cancel").onclick = renderChecklist;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector(".formerr");
    const f = new FormData(form);
    const type = /tracking|delivery|fulfil/i.test(i.item)
      ? "PROOF_OF_FULFILLMENT"
      : "OTHER";
    let ev;
    if (tracking) {
      const carrier = String(f.get("carrier")).trim(),
        number = String(f.get("number")).trim();
      ev = {
        item: i.item,
        evidence_type: type,
        notes: `${carrier} tracking ${number}`,
        tracking: { carrier, number },
      };
    } else {
      ev = {
        item: i.item,
        evidence_type: type,
        notes: String(f.get("note")).trim(),
      };
      const file = f.get("file");
      if (file && file.size) {
        const ext = file.name.split(".").pop().toLowerCase();
        const ct = FILE_TYPES[ext];
        if (!ct)
          return (
            (err.hidden = false),
            (err.textContent = "Use a .png, .jpg or .pdf file.")
          );
        if (file.size > MAX_FILE)
          return (
            (err.hidden = false),
            (err.textContent = "That file is over 5 MB.")
          );
        ev.file = {
          name: file.name,
          content_type: ct,
          data_base64: await readFile(file),
        };
      }
    }
    added.set(i.item, ev);
    renderChecklist();
    renderActions();
  };
  return form;
}

function renderActions() {
  const el = $("actions");
  el.innerHTML = "";
  if (!canAct()) return;
  const c = currentAnalysis.case;
  const amt = money(c.amount_cents, c.currency);
  const submit = document.createElement("button");
  submit.className = "primary";
  submit.textContent = "Submit response to PayPal";
  const left = stillMissing().length;
  submit.disabled = left > 0;
  submit.onclick = () => act("evidence");
  const hint = document.createElement("span");
  hint.className = "muted";
  hint.textContent = "Add the missing evidence to submit";
  hint.hidden = !left;
  const accept = document.createElement("button");
  accept.textContent = `Accept and refund ${amt}`;
  accept.onclick = () => act("accept");
  if (isFight()) {
    accept.className =
      currentAnalysis.decision?.call === "accept" ? "primary" : "";
    el.append(submit, hint, accept);
  } else {
    accept.className = "primary";
    const fa = document.createElement("button");
    fa.textContent = "Fight anyway";
    fa.onclick = () => (
      (fightAnyway = true),
      renderChecklist(),
      renderActions()
    );
    el.append(accept, fa);
  }
}

async function act(kind) {
  const c = currentAnalysis.case;
  const amt = money(c.amount_cents, c.currency);
  const path = `/api/cases/${encodeURIComponent(current)}/${kind}`;
  let body;
  if (kind === "evidence") {
    const items = [...added.values()];
    const files = items.map((e) => e.file).filter(Boolean);
    const evidence = items.map(({ file, ...e }) => e);
    if (
      !confirm(
        `Send this response and ${evidence.length} evidence item(s) to PayPal for the ${amt} dispute with ${c.buyer}?`,
      )
    )
      return;
    body = { confirm: true, text: $("draft").value };
    if (evidence.length) body.evidence = evidence;
    if (files.length) body.files = files;
  } else {
    if (!confirm(`Accept the claim and refund ${amt} to ${c.buyer}?`)) return;
    body = { note: "Accepted by the seller from the desk", confirm: true };
  }
  try {
    await post(path, body);
  } catch {
    $("action-result").innerHTML =
      `<div class="errbox">${kind === "evidence" ? "PayPal did not accept the response. Try again." : "PayPal did not accept the refund. Try again."}</div>`;
    loadActivity();
    return;
  }
  const msg =
    kind === "evidence"
      ? "Sent to PayPal. The case is now under review — PayPal usually decides within 30 days."
      : "Refund sent. Case resolved in the buyer's favour.";
  loadActivity();
  await loadCases().catch(() => {});
  await recompute(true);
  sent = msg;
  $("action-result").innerHTML = `<div class="okbox">${esc(msg)}</div>`;
  renderChecklist();
  renderActions();
}

async function search(e) {
  e.preventDefault();
  const q = $("search").value.trim();
  if (!q) return ($("results").hidden = true);
  const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const byId = new Map(allCases.map((c) => [c.dispute_id, c]));
  $("results").hidden = false;
  $("results").innerHTML =
    `<div class="muted">${r.hits.length} past case${r.hits.length === 1 ? "" : "s"} found</div>` +
    r.hits
      .map((h) => {
        const c = byId.get(h.dispute_id);
        return `<div class="hit" data-id="${esc(h.dispute_id)}"><b>${esc(c?.buyer ?? "Case " + h.dispute_id)}</b> · ${money(h.amount_cents, h.currency)} · ${esc(statusWords(c ?? h))}<br>${esc(h.snippet).replaceAll("&lt;mark&gt;", "<mark>").replaceAll("&lt;/mark&gt;", "</mark>")}</div>`;
      })
      .join("");
  for (const el of $("results").querySelectorAll(".hit"))
    el.onclick = () => openCase(el.dataset.id);
}

async function loadActivity() {
  try {
    const r = await fetch("/api/paypal-activity");
    if (!r.ok) throw 0;
    const { calls } = await r.json();
    $("activity").hidden = false;
    $("activity-list").innerHTML =
      [...calls]
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .slice(0, 6)
        .map(
          (x) =>
            `<li>${esc(x.method)} ${esc(x.path)} · <span class="${x.status < 400 ? "s-ok" : "s-bad"}">${esc(x.status)}</span> · ${esc(x.ms)} ms</li>`,
        )
        .join("") || '<li class="muted">No calls yet.</li>';
  } catch {
    $("activity").hidden = true;
  }
}

function startUrgent() {
  const n = needing();
  const now = Date.now();
  const c = n.find((x) => x.due_at && Date.parse(x.due_at) >= now) ?? n[0];
  if (c) openCase(c.dispute_id);
}

async function init() {
  setupGrid();
  $("search-form").onsubmit = (e) =>
    search(e).catch(() =>
      alert("Search is not available right now. Try again."),
    );
  $("quick").oninput = (e) =>
    gridApi.setGridOption("quickFilterText", e.target.value);
  $("recompute").onclick = () => recompute(false);
  $("start").onclick = startUrgent;
  $("close-panel").onclick = () => (
    ($("panel").hidden = true),
    (current = null)
  );
  $("show-all").onclick = (e) => (
    e.preventDefault(),
    (showAll = !showAll),
    renderCards()
  );
  $("sync").onclick = async () => {
    $("sync").disabled = true;
    try {
      await post("/api/sync", {});
      await loadCases();
    } catch {
      alert("Could not refresh from PayPal. Try again.");
    }
    $("sync").disabled = false;
  };
  const info = await api("/api/info").catch(() => null);
  if (info) {
    $("env-pill").hidden = !["mock", "sandbox"].includes(info.paypalEnv);
    $("ai-pill").hidden = !info.llm?.online;
    $("unreachable").hidden = !info.sync?.error;
  }
  await loadCases().catch(
    () =>
      ($("situation").textContent = "Could not load your disputes. Try again."),
  );
  loadActivity();
  setInterval(
    () => document.visibilityState === "visible" && loadActivity(),
    5000,
  );
}
init();

// Shared helpers + a tiny hash router. Plain JS, no framework, no build step.
// Pages live in home.js / system.js / company.js / user.js and register themselves in `pages`.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const PAGE = 10;

// UI state that survives re-renders (never any business data: that always comes from the service)
const st = { month: new Date().toISOString().slice(0, 7), user: "", histOffset: 0, usersOffset: 0, userName: "", userHist: 0, decision: "", newKey: null, detail: "" };

// ---------- calling the client's server (which calls the metering service) ----------
const calls = [];
async function call(method, url, body, label) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  calls.unshift({ status: res.status, text: label ?? `${method} ${url.replace(/^\/api/, "")}` });
  calls.length = Math.min(calls.length, 8);
  $("log").innerHTML = calls.map((c) => `<li class="s${String(c.status)[0]}">${c.status} ${esc(c.text)}</li>`).join("");
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const api = (method, path, body) => call(method, "/api/v1" + path, body);
const bodies = async (...requests) => (await Promise.all(requests)).map((r) => r.body);

function say(r, okText) {
  const m = $("msg");
  m.classList.remove("hidden", "ok", "bad");
  if (r.status >= 400) {
    m.classList.add("bad");
    m.textContent = `Error ${r.status}: ${r.body?.error?.message ?? "request failed"}${r.body?.error?.code ? ` (${r.body.error.code})` : ""}`;
  } else {
    m.classList.add("ok");
    m.textContent = okText;
  }
}

// ---------- small view helpers ----------
const planLabel = (p) => `${p.name} (${p.monthlyLimit}/mo, max ${p.maxPerRequest})`;
const options = (plans, selected) =>
  plans.map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? "selected" : ""}>${esc(planLabel(p))}</option>`).join("");
const bar = (used, limit) =>
  `<div class="bar ${used >= limit ? "full" : ""}"><i style="width:${Math.min(100, (used / limit) * 100)}%"></i></div>`;
const allowance = (u) => `${bar(u.used, u.limit)}<span class="small">${u.used} used · <b>${u.remaining} remaining</b> of ${u.limit}</span>`;
const reason = ({ scope, rule, limit }) => `${scope === "account" ? "company" : "user"} ${rule === "max_per_request" ? "per-request limit" : "monthly allowance"} (${limit})`;
const resultTag = (h) =>
  h.accepted
    ? '<span class="tag ok">accepted</span>'
    : `<span class="tag bad">rejected</span> <span class="small muted">${h.rejectScope === "account" ? "company" : "user"} ${h.rejectRule === "max_per_request" ? "per-request" : "monthly"}</span>`;
const historyTable = (items) =>
  items.length
    ? `<tr><th>Time</th><th>User</th><th>Units</th><th>Result</th><th>Company left</th><th>User left</th></tr>
      ${items.map((h) => `<tr><td>${new Date(h.createdAt).toLocaleString()}</td><td>${esc(h.externalId)}</td><td>${h.units}</td><td>${resultTag(h)}</td><td>${h.accountRemaining}</td><td>${h.userRemaining}</td></tr>`).join("")}`
    : '<tr><td class="muted">No requests.</td></tr>';
const pager = (act, offset, limit, shown, total) => `
  <div class="pager"><button class="secondary small" data-act="${act}" data-dir="-1" ${offset === 0 ? "disabled" : ""}>Previous</button>
    <span class="small muted">${shown ? offset + 1 : 0}–${offset + shown} of ${total}</span>
    <button class="secondary small" data-act="${act}" data-dir="1" ${offset + limit >= total ? "disabled" : ""}>Next</button></div>`;
const field = (root, sel) => root.querySelector(sel).value;
const crumbs = (...parts) => `<nav class="crumbs"><a href="#home">Home</a>${parts.map((p) => ` <span>/</span> ${p}`).join("")}</nav>`;

// ---------- the company the client is currently working as ----------
async function companyBar(extra = "") {
  const { companies } = (await call("GET", "/api/companies?light=1")).body;
  return `<div class="company-bar">
    <label class="small muted" for="company-select">Company</label>
    <select id="company-select">${companies.map((c) => `<option value="${esc(c.id)}" ${c.current ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
    ${extra}</div>`;
}
document.addEventListener("change", async (e) => {
  if (e.target.id !== "company-select") return;
  await call("POST", "/api/companies/select", { id: e.target.value }, "POST /api/companies/select");
  resetUiState();
  await render();
});
function resetUiState() {
  Object.assign(st, { decision: "", usersOffset: 0, histOffset: 0, userHist: 0, user: "", userName: "", detail: "", newKey: null });
}

// ---------- actions (buttons / selects with data-act) and routing ----------
const actions = {};
const pages = {};

async function onAction(e) {
  const el = e.target.closest("[data-act]");
  // buttons act on click; selects, inputs and the month picker act on change
  if (!el || (e.type === "click") !== (el.tagName === "BUTTON")) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  el.disabled = true;
  if (!["plan-detail", "user-detail"].includes(el.dataset.act)) st.detail = "";
  const outcome = await fn(el, el.closest("tr") ?? el.closest("[data-form]"));
  if (outcome !== "navigated") await render(); // an action that changed the page (hash) re-renders through hashchange
}

function parseRoute() {
  const [page = "home", section = ""] = location.hash.replace(/^#\/?/, "").split("/");
  return { page: pages[page] ? page : "home", section };
}
async function render() {
  const { page, section } = parseRoute();
  await pages[page](section);
}
window.addEventListener("hashchange", () => {
  $("msg").classList.add("hidden");
  st.detail = "";
  st.newKey = null;
  render();
});
function start() {
  $("view").addEventListener("click", onAction);
  $("view").addEventListener("change", onAction);
  render();
}

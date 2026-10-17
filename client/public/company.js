// Company page: everything a company can do with its API key, in five sections.
const COMPANY_SECTIONS = [["overview", "Overview & plan"], ["plans", "Plans"], ["users", "Employees"], ["keys", "API keys"], ["usage", "Usage & history"]];
const companySections = {};

pages.company = async function (section) {
  const active = COMPANY_SECTIONS.some(([k]) => k === section) ? section : "overview";
  const bar = await companyBar();
  const body = await companySections[active]();
  const nav = `<div class="pills">${COMPANY_SECTIONS.map(([k, label]) => `<a href="#company/${k}" class="${k === active ? "active" : ""}">${label}</a>`).join("")}</div>`;
  $("view").innerHTML = `${crumbs("Company")}${bar}${nav}${body}`;
};

// plans in two groups, so "predefined" and "the company's own" are easy to tell apart
const groupedOptions = (plans, selected) =>
  `<optgroup label="Predefined">${options(plans.filter((p) => p.predefined), selected)}</optgroup>` +
  (plans.some((p) => !p.predefined) ? `<optgroup label="This company's own">${options(plans.filter((p) => !p.predefined), selected)}</optgroup>` : "");

// ---------- Overview & plan ----------
companySections.overview = async () => {
  const [acc, usage, plans] = await bodies(api("GET", "/account"), api("GET", "/usage"), api("GET", "/plans"));
  const accountPlans = plans.plans.filter((p) => p.scope === "account");
  const own = accountPlans.filter((p) => !p.predefined);
  return `
    <section class="card stack"><h2>${esc(acc.account.name)}</h2>
      <p class="small muted">Account <code>${esc(acc.account.id)}</code> · created ${new Date(acc.account.createdAt).toLocaleString()} · stored in PostgreSQL</p>
      <div><div class="muted small">Shared allowance of all employees (${esc(usage.usage.period)}, UTC)</div>${allowance(usage.usage.account)}</div>
    </section>
    <section class="card stack"><h2>The company's plan</h2>
      <p class="muted">The company plan sets the limits shared by <b>all</b> employees. Pick a predefined plan or one of this company's own plans. Units already used this month are kept when the plan changes.</p>
      <div class="form"><label>Current plan <select data-act="account-plan">${groupedOptions(accountPlans, acc.account.plan.id)}</select></label></div>
      <p class="small muted">${own.length ? `This company has ${own.length} plan(s) of its own.` : "This company has no plan of its own yet, so only the predefined plans are offered."}
        <a href="#company/plans">Create or edit plans →</a></p>
    </section>`;
};

// ---------- Plans: company plans vs employee plans ----------
companySections.plans = async () => {
  const [plans, users, acc] = await bodies(api("GET", "/plans"), api("GET", "/users?limit=200"), api("GET", "/account"));
  const usersOnPlan = {};
  for (const u of users.users) usersOnPlan[u.plan.id] = (usersOnPlan[u.plan.id] ?? 0) + 1;

  const table = (scope) => `<div class="scroll"><table>
    <tr><th>Name</th><th>Monthly</th><th>Per request</th><th>In use</th><th></th></tr>
    ${plans.plans.filter((p) => p.scope === scope).map((p) => {
      const inUse = scope === "account"
        ? (p.id === acc.account.plan.id ? '<span class="badge green">current plan</span>' : '<button class="secondary small" data-act="account-plan-use">Use for company</button>')
        : `${usersOnPlan[p.id] ?? 0} employee(s)`;
      return p.predefined
        ? `<tr data-id="${esc(p.id)}"><td>${esc(p.name)} <span class="badge">predefined</span></td><td>${p.monthlyLimit}</td><td>${p.maxPerRequest}</td><td>${inUse}</td>
            <td><button class="secondary small" data-act="plan-detail">Details</button></td></tr>`
        : `<tr data-id="${esc(p.id)}"><td><input type="text" class="name" value="${esc(p.name)}" /></td>
            <td><input type="number" class="monthly" min="1" value="${p.monthlyLimit}" /></td>
            <td><input type="number" class="perreq" min="1" value="${p.maxPerRequest}" /></td><td>${inUse}</td>
            <td><div class="row-actions"><button class="small" data-act="save-plan">Save</button>
              <button class="secondary small" data-act="plan-detail">Details</button>
              <button class="danger small" data-act="archive-plan">Archive</button></div></td></tr>`;
    }).join("")}
  </table></div>`;

  const createForm = (scope, name, monthly, perreq) => `<div class="form" data-form="new-plan" data-scope="${scope}">
    <label>Name <input type="text" class="name" value="${name}" /></label>
    <label>Monthly allowance <input type="number" class="monthly" min="1" value="${monthly}" /></label>
    <label>Max per request <input type="number" class="perreq" min="1" value="${perreq}" /></label>
    <button data-act="create-plan">Create ${scope === "account" ? "company" : "employee"} plan</button></div>`;

  return `
    <section class="card stack"><h2>Company plans</h2>
      <p class="muted">Apply to the <b>whole company</b>: the monthly allowance is shared by all employees. The company uses exactly one of them.</p>
      ${table("account")}${createForm("account", "Growth", 5000, 200)}
    </section>
    <section class="card stack"><h2>Employee plans</h2>
      <p class="muted">Apply to <b>individual employees</b> (assign them in “Employees”). Several employees can share a plan; each still has their own usage. An employee plan never raises the company's shared allowance.</p>
      ${table("user")}${createForm("user", "Team plan", 500, 50)}
    </section>
    ${st.detail ? `<div class="detail">${esc(st.detail)}</div>` : ""}
    <p class="small muted">Predefined plans are read-only. Editing one of your own plans takes effect from the next request; a plan can be archived only while nobody uses it.</p>`;
};

// ---------- Employees ----------
companySections.users = async () => {
  const [users, plans] = await bodies(api("GET", `/users?limit=${PAGE}&offset=${st.usersOffset}`), api("GET", "/plans"));
  const userPlans = plans.plans.filter((p) => p.scope === "user");
  const { total, limit, offset } = users.pagination;
  return `
    <section class="card stack" data-form="new-user"><h2>Add an employee</h2>
      <p class="muted">The id is whatever your app uses (<code>externalId</code>). Without a plan the predefined Basic plan is used.</p>
      <div class="form">
        <label>Employee id <input type="text" class="external" placeholder="employee-42" /></label>
        <label>Plan <select class="plan"><option value="">Default (Basic)</option>${groupedOptions(userPlans)}</select></label>
        <button data-act="add-user">Add employee</button>
      </div>
    </section>
    <section class="card"><h2>Employees (${total})</h2><div class="scroll"><table>
      <tr><th>Employee</th><th>Plan</th><th>Added</th><th></th></tr>
      ${users.users.map((u) => `<tr data-id="${esc(u.id)}" data-user="${esc(u.externalId)}">
        <td><b>${esc(u.externalId)}</b></td>
        <td><select data-act="user-plan">${groupedOptions(userPlans, u.plan.id)}</select></td>
        <td>${new Date(u.createdAt).toLocaleString()}</td>
        <td><div class="row-actions"><button class="small" data-act="open-user">Open as employee</button>
          <button class="secondary small" data-act="user-detail">Details</button>
          <button class="danger small" data-act="delete-user">Delete</button></div></td></tr>`).join("")}
    </table></div>
    ${st.detail ? `<div class="detail">${esc(st.detail)}</div>` : ""}
    ${pager("users-page", offset, limit, users.users.length, total)}</section>`;
};

// ---------- API keys ----------
companySections.keys = async () => {
  const [keys, session] = await bodies(api("GET", "/account/api-keys"), call("GET", "/api/session", null, "GET /api/session (this client)"));
  return `
    <section class="card stack"><h2>API keys</h2>
      <p class="muted">The company's backend sends one of these keys in the <code>X-API-Key</code> header. The service stores only a hash, so a key is shown once when it is created.</p>
      <div class="scroll"><table>
        <tr><th>Prefix</th><th>Created</th><th>Status</th><th></th></tr>
        ${keys.apiKeys.map((k) => {
          const inUse = k.prefix === session.keyPrefix && !k.revokedAt;
          return `<tr data-id="${esc(k.id)}"><td><code>${esc(k.prefix)}…</code></td><td>${new Date(k.createdAt).toLocaleString()}</td>
            <td>${k.revokedAt ? '<span class="badge">revoked</span>' : inUse ? '<span class="badge green">active · used by this client</span>' : '<span class="badge green">active</span>'}</td>
            <td>${k.revokedAt || inUse ? "" : '<button class="danger small" data-act="revoke-key">Revoke</button>'}</td></tr>`;
        }).join("")}
      </table></div>
      <div class="form">
        <button data-act="create-key">Create an additional key</button>
        <button class="secondary" data-act="rotate-key">Rotate (new key → switch → revoke old)</button>
      </div>
      ${st.newKey ? `<div class="keybox">New key (shown only once): ${esc(st.newKey)}</div>` : ""}
      <div class="form"><span class="small muted">What the service answers without a valid key:</span>
        <button class="secondary small" data-act="try-key" data-mode="missing">No key</button>
        <button class="secondary small" data-act="try-key" data-mode="wrong">Wrong key</button></div>
    </section>`;
};

// ---------- Usage & history ----------
companySections.usage = async () => {
  const who = st.user ? `&externalId=${encodeURIComponent(st.user)}` : "";
  const [users, usage, per, hist] = await bodies(
    api("GET", "/users?limit=200"),
    api("GET", `/usage?month=${st.month}${who}`),
    api("GET", `/usage/users?month=${st.month}&limit=50`),
    api("GET", `/usage/history?month=${st.month}${who}&limit=${PAGE}&offset=${st.histOffset}`),
  );
  const u = usage.usage;
  const h = hist.history.pagination;
  return `
    <section class="card"><div class="form">
      <label>Month (UTC) <input type="month" id="f-month" data-act="usage-filter" value="${esc(st.month)}" /></label>
      <label>Employee <select id="f-user" data-act="usage-filter"><option value="">All employees</option>
        ${users.users.map((x) => `<option ${x.externalId === st.user ? "selected" : ""}>${esc(x.externalId)}</option>`).join("")}</select></label>
    </div>
    <p class="muted small" style="margin-top:8px">Past months show the usage as it was; the limits shown are those of the plans assigned now.</p></section>
    <section class="card"><h2>Usage in ${esc(u.period)}</h2>
      <div class="account-row"><div><div class="muted small">Company (shared)</div>${allowance(u.account)}</div>
      ${u.user ? `<div><div class="muted small">${esc(u.user.externalId)}</div>${allowance(u.user)}</div>` : ""}</div></section>
    <section class="card"><h2>Every employee in ${esc(u.period)}</h2><div class="scroll"><table>
      <tr><th>Employee</th><th>Plan</th><th>Allowance</th></tr>
      ${per.users.map((x) => `<tr><td><b>${esc(x.externalId)}</b></td><td>${esc(x.plan.name)}</td><td>${allowance(x)}</td></tr>`).join("") || '<tr><td class="muted">No employees.</td></tr>'}
    </table></div></section>
    <section class="card"><h2>Request history</h2><div class="scroll"><table>${historyTable(hist.history.items)}</table></div>
      ${pager("hist-page", h.offset, h.limit, h.returned, h.total)}</section>`;
};

// ---------- actions of the company page ----------
Object.assign(actions, {
  async "account-plan"(el) {
    say(await api("PUT", "/account/plan", { planId: el.value }), "Company plan changed. It applies from the next request; usage so far is kept.");
  },
  async "account-plan-use"(el, row) {
    say(await api("PUT", "/account/plan", { planId: row.dataset.id }), "Company plan changed. It applies from the next request; usage so far is kept.");
  },
  async "create-plan"(el, box) {
    const scope = box.dataset.scope;
    const r = await api("POST", "/plans", {
      name: field(box, ".name"), scope,
      monthlyLimit: Number(field(box, ".monthly")), maxPerRequest: Number(field(box, ".perreq")),
    });
    say(r, scope === "account" ? "Company plan created. Use it with “Use for company”." : "Employee plan created. Assign it in “Employees”.");
  },
  async "save-plan"(el, row) {
    const r = await api("PATCH", `/plans/${row.dataset.id}`, {
      name: field(row, ".name"), monthlyLimit: Number(field(row, ".monthly")), maxPerRequest: Number(field(row, ".perreq")),
    });
    say(r, "Plan updated. Everyone using it is affected from the next request.");
  },
  async "archive-plan"(el, row) {
    say(await api("DELETE", `/plans/${row.dataset.id}`), "Plan archived.");
  },
  async "plan-detail"(el, row) {
    st.detail = JSON.stringify((await api("GET", `/plans/${row.dataset.id}`)).body.plan, null, 2);
  },
  async "add-user"(el, box) {
    const planId = field(box, ".plan");
    say(await api("POST", "/users", { externalId: field(box, ".external"), ...(planId ? { planId } : {}) }), "Employee added.");
  },
  async "user-plan"(el, row) {
    say(await api("PUT", `/users/${row.dataset.id}/plan`, { planId: el.value }), "Employee plan changed. It applies from the next request; usage so far is kept.");
  },
  async "delete-user"(el, row) {
    say(await api("DELETE", `/users/${row.dataset.id}`), "Employee deleted. Their request history is kept.");
  },
  async "user-detail"(el, row) {
    st.detail = JSON.stringify((await api("GET", `/users/${row.dataset.id}`)).body.user, null, 2);
  },
  async "open-user"(el, row) {
    st.userName = row.dataset.user;
    st.decision = "";
    location.hash = "#user";
    return "navigated";
  },
  async "users-page"(el) { st.usersOffset = Math.max(0, st.usersOffset + Number(el.dataset.dir) * PAGE); },
  async "hist-page"(el) { st.histOffset = Math.max(0, st.histOffset + Number(el.dataset.dir) * PAGE); },
  async "usage-filter"() {
    st.month = $("f-month").value || st.month;
    st.user = $("f-user").value;
    st.histOffset = 0;
  },
  async "create-key"() {
    const r = await api("POST", "/account/api-keys");
    st.newKey = r.status === 201 ? r.body.apiKey.key : null;
    say(r, "Key created. Copy it now; the service only stores its hash.");
  },
  async "rotate-key"() {
    say(await call("POST", "/api/rotate-key", {}, "POST /api/rotate-key (create → switch → revoke old)"), "Rotated: this client now uses the new key and the old one is revoked.");
  },
  async "revoke-key"(el, row) {
    say(await api("DELETE", `/account/api-keys/${row.dataset.id}`), "Key revoked.");
  },
  async "try-key"(el) {
    say(await call("POST", "/api/try-key", { mode: el.dataset.mode }, `GET /v1/account with ${el.dataset.mode} key`), "");
  },
});

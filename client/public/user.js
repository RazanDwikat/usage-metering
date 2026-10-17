// User page: what one employee sees in the company's app. The employee has no credentials;
// the company's backend (this client's server) calls the service on their behalf.
pages.user = async function () {
  const bar = await companyBar();
  const { users } = (await api("GET", "/users?limit=200")).body;
  if (!users.length) {
    $("view").innerHTML = `${crumbs("Employee")}${bar}<section class="card"><p>This company has no employees yet. Add some in <a href="#company/users">Company → Employees</a>.</p></section>`;
    return;
  }
  if (!users.some((u) => u.externalId === st.userName)) st.userName = users[users.length - 1].externalId; // the oldest
  const me = users.find((u) => u.externalId === st.userName);
  const who = encodeURIComponent(me.externalId);
  const [usage, acc, hist] = await bodies(
    api("GET", `/usage?externalId=${who}`),
    api("GET", "/account"),
    api("GET", `/usage/history?externalId=${who}&limit=${PAGE}&offset=${st.userHist}`),
  );
  const mine = usage.usage.user;
  const h = hist.history.pagination;

  $("view").innerHTML = `
    ${crumbs("Employee")}${bar}
    <section class="card"><div class="form">
      <label>Employee <select data-act="pick-user">${[...users].reverse().map((u) => `<option ${u.externalId === me.externalId ? "selected" : ""}>${esc(u.externalId)}</option>`).join("")}</select></label>
      <span class="small muted">Employees don't log in to the service: the company's app asks it for them.</span>
    </div></section>

    <section class="card stack"><h2>Limits that apply to ${esc(me.externalId)} (${esc(usage.usage.period)})</h2>
      <p class="muted">Every request must fit <b>both</b> rows. The company's allowance is shared by all employees.</p>
      <div class="scroll"><table>
        <tr><th></th><th>Plan</th><th>Monthly allowance</th><th>Max per request</th></tr>
        <tr><td><b>${esc(me.externalId)}</b> (employee)</td><td>${esc(me.plan.name)}</td><td>${allowance(mine)}</td><td>${me.plan.maxPerRequest}</td></tr>
        <tr><td><b>${esc(acc.account.name)}</b> (company, shared)</td><td>${esc(acc.account.plan.name)}</td><td>${allowance(usage.usage.account)}</td><td>${acc.account.plan.maxPerRequest}</td></tr>
      </table></div>
    </section>

    <section class="card stack" data-form="process"><h2>Process a document</h2>
      <p class="muted">Each click asks the service to consume that many units for ${esc(me.externalId)}. If any rule says no, nothing is consumed.</p>
      <div class="form"><label>Units <input class="units" type="number" min="1" value="5" /></label><button data-act="process">Process</button></div>
      ${st.decision ? `<div class="decision">${st.decision}</div>` : ""}
    </section>

    <section class="card"><h2>${esc(me.externalId)}'s requests this month</h2><div class="scroll"><table>${historyTable(hist.history.items)}</table></div>
      ${pager("user-hist-page", h.offset, h.limit, h.returned, h.total)}</section>

    <p class="small muted">An employee can't change their own plan or the company's: the company does that in
      <a href="#company/users">Company → Employees</a> and <a href="#company/overview">Company → Overview</a>.</p>`;
};

function decisionHtml(externalId, units, r) {
  if (r.status !== 200) return `<p><span class="tag bad">error ${r.status}</span> ${esc(r.body?.error?.message ?? "request failed")}</p>`;
  const d = r.body;
  const head = d.accepted
    ? `<p><span class="tag ok">accepted</span> <b>${esc(externalId)}</b> processed a document of ${units} units.</p>`
    : `<p><span class="tag bad">rejected</span> ${units} units for <b>${esc(externalId)}</b> were blocked by the <b>${esc(reason(d.rejection))}</b>. Nothing was consumed.</p>`;
  return `${head}<p class="small muted">Remaining after this request → company: ${d.remaining.account}, ${esc(externalId)}: ${d.remaining.user}${d.replayed ? " (repeat of an earlier request)" : ""}</p>`;
}

Object.assign(actions, {
  async "pick-user"(el) {
    st.userName = el.value;
    st.decision = "";
    st.userHist = 0;
  },
  async process(el, box) {
    const units = Number(field(box, ".units"));
    const r = await call("POST", "/api/consume", { externalId: st.userName, units }, "POST /v1/consume");
    st.decision = decisionHtml(st.userName, units, r);
  },
  async "user-hist-page"(el) { st.userHist = Math.max(0, st.userHist + Number(el.dataset.dir) * PAGE); },
});

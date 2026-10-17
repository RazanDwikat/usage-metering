// System (operator) page: all companies with their plans, and adding a company.
pages.system = async function () {
  const [list, plans] = (await Promise.all([call("GET", "/api/companies"), api("GET", "/plans")])).map((r) => r.body);
  const accountPlans = plans.plans.filter((p) => p.scope === "account" && p.predefined);
  $("view").innerHTML = `
    ${crumbs("System (operator)")}
    <section class="card stack"><h2>Companies</h2>
      <p class="muted">Every company is a separate <b>account in the database</b> with its own plan, users, usage and API key.</p>
      <div class="scroll"><table>
        <tr><th>Company</th><th>Plan</th><th>Own plans</th><th>Users</th><th>Used this month</th><th></th></tr>
        ${list.companies.filter((c) => c.reachable).map((c) => `
          <tr data-id="${esc(c.id)}">
            <td><b>${esc(c.name)}</b>${c.current ? ' <span class="badge green">selected</span>' : ""}<div class="small muted">created ${new Date(c.createdAt).toLocaleString()}</div></td>
            <td>${esc(c.plan.name)}<div class="small muted">${c.plan.monthlyLimit}/mo · max ${c.plan.maxPerRequest}</div></td>
            <td class="small">${c.customPlans.length ? c.customPlans.map((p) => `${esc(p.name)} <span class="muted">(${p.scope === "account" ? "company" : "employees"})</span>`).join("<br>") : '<span class="muted">none</span>'}</td>
            <td>${c.users}</td>
            <td>${allowance(c.usage)}</td>
            <td><button class="small" data-act="open-company">Open company</button></td>
          </tr>`).join("")}
      </table></div>
    </section>

    <section class="card stack" data-form="new-account"><h2>Add a company</h2>
      <p class="muted">The operator creates the account (with the admin token). The service returns the company's API key once; this demo client keeps it so you can open the company afterwards.</p>
      <div class="form">
        <label>Company name <input type="text" class="name" value="My company" /></label>
        <label>Starting plan <select class="plan">
          <option value="demo">Sample plan (100/mo, max 50 – easy to hit)</option>
          ${accountPlans.map((p) => `<option value="${esc(p.id)}">${esc(planLabel(p))}</option>`).join("")}
        </select></label>
        <label><span>Sample data</span><span><input type="checkbox" class="seed" checked /> users alice, bob, carol + employee plans</span></label>
        <button data-act="create-account">Add company</button>
      </div>
      <p class="small muted">The company can later change its plan or create its own plans (Company → Plans).</p>
    </section>`;
};

Object.assign(actions, {
  async "create-account"(el, box) {
    const r = await call("POST", "/api/accounts", {
      name: field(box, ".name"), planId: field(box, ".plan"), seed: box.querySelector(".seed").checked,
    }, "POST /v1/accounts (operator)");
    resetUiState();
    say(r, `Company “${r.body?.account?.name}” created. The other companies are untouched.`);
  },
  async "open-company"(el, row) {
    await call("POST", "/api/companies/select", { id: row.dataset.id }, "POST /api/companies/select");
    resetUiState();
    location.hash = "#company/overview";
    return "navigated";
  },
});

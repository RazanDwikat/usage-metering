// Home: three entrances, one per role of the system.
pages.home = async function () {
  const { companies } = (await call("GET", "/api/companies")).body;
  const here = companies.find((c) => c.current);
  $("view").innerHTML = `
    <h1 class="title">Choose what you want to look at</h1>
    <p class="muted">The system has three kinds of actors. Each one can do different things, and each card opens the screen for that actor.</p>
    <div class="role-cards">
      <a class="role-card" href="#system">
        <span class="role">1 · System</span>
        <h2>The operator</h2>
        <p>Owns the service. Sees <b>every company</b>, its plan and its usage, and <b>adds new companies</b>.</p>
        <div class="meta">Proves who it is with: <b>admin token</b></div>
        <div class="count">${companies.length} ${companies.length === 1 ? "company" : "companies"}</div>
      </a>
      <a class="role-card" href="#company/overview">
        <span class="role">2 · Company</span>
        <h2>A company</h2>
        <p>Manages <b>its own plan</b>, creates <b>plans for its employees</b>, registers users, handles API keys and reads usage and history.</p>
        <div class="meta">Proves who it is with: <b>its API key</b></div>
        <div class="count">Working as: ${esc(here?.name ?? "–")}</div>
      </a>
      <a class="role-card" href="#user">
        <span class="role">3 · User</span>
        <h2>An employee</h2>
        <p>What one employee sees in the company's app: their limits, their remaining allowance, <b>processing a document</b> and their own requests.</p>
        <div class="meta">No credentials: the <b>company's backend</b> calls the service for them</div>
        <div class="count">${here ? `${here.users} user(s) in ${esc(here.name)}` : ""}</div>
      </a>
    </div>
    <p class="muted small">Companies, users, plans, usage and history are stored by the service in PostgreSQL and survive restarts.</p>`;
};

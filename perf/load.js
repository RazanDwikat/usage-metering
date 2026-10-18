// k6 load test for the usage metering service.
//   docker compose --profile perf run --rm k6 run -e SCENARIO=hot_account /perf/load.js
// SCENARIO: distributed | hot_account | hot_user | limit_account | limit_user | retry_storm
// Optional: -e VUS=50 -e DURATION=30s (constant-load scenarios only)
import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.2/index.js";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const ADMIN = __ENV.ADMIN_TOKEN || "dev-admin-token";
const SCENARIO = __ENV.SCENARIO || "distributed";
const VUS = Number(__ENV.VUS || 50);
const BIG = 1_000_000_000; // an allowance that is never reached

// accounts x users per account, plan limits, and the exact outcome the server MUST end up with (when it is deterministic).
const SCENARIOS = {
  // best case: many accounts, so requests rarely touch the same counter rows
  distributed: { accounts: 20, users: 20, accountLimit: BIG, userLimit: BIG, constant: true },
  // worst case for the shared counter: every request of the account updates the same account row
  hot_account: { accounts: 1, users: 50, accountLimit: BIG, userLimit: BIG, constant: true },
  // one user hammered: user row and both counters are contended
  hot_user: { accounts: 1, users: 1, accountLimit: BIG, userLimit: BIG, constant: true },
  // the ACCOUNT allowance (1000) runs out long before the users' (10 x 300): exactly 1000 units must be accepted
  limit_account: { accounts: 1, users: 10, accountLimit: 1000, userLimit: 300, iterations: 5000, expectAccountUsed: 1000 },
  // each USER allowance (80) runs out first: every user must end at exactly 80, the account at 800
  limit_user: { accounts: 1, users: 10, accountLimit: BIG, userLimit: 80, iterations: 5000, expectAccountUsed: 800, expectEachUserUsed: 80 },
  // 5000 requests over only 200 distinct requestIds, many at the same time: each id counts once (200 units), 4800 are replays
  retry_storm: { accounts: 1, users: 1, accountLimit: BIG, userLimit: BIG, iterations: 5000, ids: 200, expectAccountUsed: 200 },
};
const S = SCENARIOS[SCENARIO];
if (!S) throw new Error(`unknown SCENARIO '${SCENARIO}' (use: ${Object.keys(SCENARIOS).join(", ")})`);

const acceptedUnits = new Counter("accepted_units");
const rejectedRequests = new Counter("rejected_requests");
const replayedRequests = new Counter("replayed_requests");

const thresholds = { http_req_failed: ["rate==0"], checks: ["rate==1"] }; // a quota rejection is a 200, so any non-2xx is a real error
if (S.expectAccountUsed !== undefined) thresholds.accepted_units = [`count==${S.expectAccountUsed}`];
if (S.ids) thresholds.replayed_requests = [`count==${S.iterations - S.ids}`];

export const options = {
  setupTimeout: "300s",
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
  thresholds,
  scenarios: {
    [SCENARIO]: S.constant
      ? { executor: "constant-vus", vus: VUS, duration: __ENV.DURATION || "30s" }
      : { executor: "shared-iterations", vus: VUS, iterations: S.iterations, maxDuration: "5m" },
  },
};

const json = (key) => ({ headers: { "Content-Type": "application/json", ...(key ? { "x-api-key": key } : { "x-admin-token": ADMIN }) } });

function post(path, body, key) {
  const res = http.post(`${BASE}${path}`, JSON.stringify(body), { ...json(key), tags: { name: "setup" } });
  if (res.status >= 300) throw new Error(`setup ${path} -> ${res.status} ${res.body}`);
  return res.json();
}

export function setup() {
  const run = Date.now();
  const accounts = [];
  for (let a = 0; a < S.accounts; a++) {
    const created = post("/v1/accounts", { name: `load-${SCENARIO}-${run}-${a}` });
    const key = created.apiKey.key;
    const accPlan = post("/v1/plans", { name: "load-acc", scope: "account", monthlyLimit: S.accountLimit, maxPerRequest: Math.min(100, S.accountLimit) }, key).plan;
    const usrPlan = post("/v1/plans", { name: "load-usr", scope: "user", monthlyLimit: S.userLimit, maxPerRequest: Math.min(100, S.userLimit) }, key).plan;
    const put = http.put(`${BASE}/v1/account/plan`, JSON.stringify({ planId: accPlan.id }), { ...json(key), tags: { name: "setup" } });
    if (put.status !== 200) throw new Error(`assign account plan -> ${put.status} ${put.body}`);
    const users = [];
    for (let u = 0; u < S.users; u++) {
      post("/v1/users", { externalId: `u${u}`, planId: usrPlan.id }, key);
      users.push(`u${u}`);
    }
    accounts.push({ key, users });
  }
  return { run, accounts };
}

export default function (data) {
  const i = exec.scenario.iterationInTest;
  let account, user, requestId;
  if (S.ids) {
    // same few requestIds again and again, concurrently
    account = data.accounts[0];
    user = account.users[0];
    requestId = `storm-${i % S.ids}`;
  } else if (S.iterations) {
    // round-robin so every user gets the same share of requests
    account = data.accounts[0];
    user = account.users[i % account.users.length];
    requestId = `${data.run}-${i}`;
  } else {
    account = data.accounts[Math.floor(Math.random() * data.accounts.length)];
    user = account.users[Math.floor(Math.random() * account.users.length)];
    requestId = `${data.run}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}`;
  }

  const res = http.post(`${BASE}/v1/consume`, JSON.stringify({ requestId, externalId: user, units: 1 }), {
    ...json(account.key),
    tags: { name: "consume" },
  });
  const ok = check(res, { "consume returned 200": (r) => r.status === 200 });
  if (!ok) return;

  const body = res.json();
  if (body.replayed) replayedRequests.add(1);
  else if (body.accepted) acceptedUnits.add(body.units);
  else rejectedRequests.add(1);
}

// Runs once after the load: the SERVER's own numbers must be consistent (and exact where the scenario is deterministic).
export function teardown(data) {
  const problems = [];
  let totalUsed = 0;
  data.accounts.forEach((acc, idx) => {
    const get = (path) => http.get(`${BASE}${path}`, { ...json(acc.key), tags: { name: "verify" } }).json();
    const account = get("/v1/usage").usage.account;
    const users = [];
    for (let offset = 0; ; offset += 200) {
      const page = get(`/v1/usage/users?limit=200&offset=${offset}`).users;
      users.push(...page);
      if (page.length < 200) break;
    }
    const sum = users.reduce((s, u) => s + u.used, 0);
    totalUsed += account.used;

    if (account.used > account.limit) problems.push(`account ${idx}: used ${account.used} > limit ${account.limit}`);
    if (sum !== account.used) problems.push(`account ${idx}: account used ${account.used} != sum of its users ${sum}`);
    users.forEach((u) => {
      if (u.used > u.limit) problems.push(`account ${idx} ${u.externalId}: used ${u.used} > limit ${u.limit}`);
      if (S.expectEachUserUsed !== undefined && u.used !== S.expectEachUserUsed)
        problems.push(`account ${idx} ${u.externalId}: used ${u.used}, expected exactly ${S.expectEachUserUsed}`);
    });
    if (S.expectAccountUsed !== undefined && account.used !== S.expectAccountUsed)
      problems.push(`account ${idx}: used ${account.used}, expected exactly ${S.expectAccountUsed}`);
  });

  console.log(`VERIFY ${SCENARIO}: server total used = ${totalUsed} (compare with accepted_units in the summary: they must be equal)`);
  if (problems.length) {
    console.error(`VERIFY FAILED:\n  ${problems.join("\n  ")}`);
    throw new Error(`${problems.length} invariant violation(s)`);
  }
  console.log("VERIFY OK: no limit exceeded, account total == sum of its users" + (S.expectAccountUsed !== undefined ? ", exact expected totals" : ""));
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: " ", enableColors: false }),
    [`results/${SCENARIO}.json`]: JSON.stringify(data, null, 2),
  };
}
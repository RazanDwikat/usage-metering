// Example client application ("Docs App"). It stands in for a real company backend:
// it holds the account's API key and calls the metering service on behalf of its users.
// The browser only talks to this server, so the key never reaches the page.
//
//   /api/v1/*       -> forwarded to the service's /v1/* with the account's API key added
//   /api/consume    -> "process a document": adds a fresh requestId and calls POST /v1/consume
//   /api/companies  -> the companies this client knows (each is a real account in the service's database)
//   /api/accounts   -> operator action: creates an account (admin token) and switches this client to it
//   /api/rotate-key -> creates a new key, switches to it, revokes the old one
//   /api/try-key    -> shows how the service answers a missing / wrong key
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE_URL = process.env.SERVICE_URL ?? "http://localhost:3000";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev-admin-token";
const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const FILES = Object.fromEntries(["index.html", "style.css", "core.js", "home.js", "system.js", "company.js", "user.js"].map((f) => [f === "index.html" ? "/" : "/" + f, f]));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// An API key is shown only once, so this client remembers the keys of the companies it created.
// (Demo only: a real application has ONE key in its secret store. Here the keys are kept in a small
// JSON file so that switching companies works and survives a restart. The companies themselves live
// in the service's PostgreSQL database.)
const DATA_FILE = process.env.DATA_FILE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "companies.json");
let registry = { currentId: null, companies: [] };
const current = () => registry.companies.find((c) => c.id === registry.currentId);
const apiKey = () => current()?.apiKey;
const loadRegistry = async () => { try { registry = JSON.parse(await readFile(DATA_FILE, "utf8")); } catch {} };
const saveRegistry = async () => {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(registry, null, 2));
};

/** One call to the metering service. Returns { status, body }. */
async function metering(method, url, { body, admin = false, key = apiKey() } = {}) {
  const headers = {};
  if (admin) headers["x-admin-token"] = ADMIN_TOKEN;
  else if (key) headers["x-api-key"] = key;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(SERVICE_URL + url, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Creates an account, makes it the one this client works with, and optionally adds sample data. */
async function createAccount({ name, planId, seed }) {
  // "demo" = a small custom account plan so limits are easy to hit
  const created = await metering("POST", "/v1/accounts", {
    admin: true,
    body: { name, ...(planId && planId !== "demo" ? { planId } : {}) },
  });
  if (created.status !== 201) return created;
  registry.companies.push({ id: created.body.account.id, name, apiKey: created.body.apiKey.key, createdAt: created.body.account.createdAt });
  registry.currentId = created.body.account.id;
  await saveRegistry();

  const makePlan = async (plan) => (await metering("POST", "/v1/plans", { body: plan })).body.plan;
  if (planId === "demo") {
    const company = await makePlan({ name: "Demo Company", scope: "account", monthlyLimit: 100, maxPerRequest: 50 });
    await metering("PUT", "/v1/account/plan", { body: { planId: company.id } });
  }
  if (seed) {
    const basic = await makePlan({ name: "Demo Basic", scope: "user", monthlyLimit: 60, maxPerRequest: 10 });
    const premium = await makePlan({ name: "Demo Premium", scope: "user", monthlyLimit: 100, maxPerRequest: 40 });
    for (const [externalId, plan] of [["alice", basic], ["bob", premium], ["carol", basic]]) {
      await metering("POST", "/v1/users", { body: { externalId, planId: plan.id } });
    }
  }
  return created;
}

/** What the service (i.e. the database) says about one company. */
async function describeCompany(c) {
  const call = (url) => metering("GET", url, { key: c.apiKey });
  const acc = await call("/v1/account");
  if (acc.status !== 200) return { id: c.id, name: c.name, reachable: false };
  const [users, usage, plans] = await Promise.all([call("/v1/users?limit=1"), call("/v1/usage"), call("/v1/plans")]);
  return {
    id: c.id, name: acc.body.account.name, reachable: true, plan: acc.body.account.plan,
    createdAt: acc.body.account.createdAt, users: users.body.pagination.total, current: c.id === registry.currentId,
    usage: usage.body.usage.account,
    customPlans: plans.body.plans.filter((p) => !p.predefined).map((p) => ({ name: p.name, scope: p.scope })),
  };
}

async function waitForService() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(SERVICE_URL + "/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Metering service is not reachable at " + SERVICE_URL);
}

const readRaw = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
};
const readJson = async (req) => {
  const raw = await readRaw(req);
  return raw.length ? JSON.parse(raw.toString()) : {};
};

const send = (res, status, body) => {
  if (status === 204 || body == null) return res.writeHead(status).end();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function handleApi(req, res, { pathname, search }) {
  // Pass-through to the metering service (the account's key is added here, not in the browser).
  if (pathname.startsWith("/api/v1/") && pathname !== "/api/v1/accounts") {
    const raw = await readRaw(req);
    const headers = { "x-api-key": apiKey() };
    if (raw.length) headers["content-type"] = "application/json";
    const r = await fetch(SERVICE_URL + pathname.slice(4) + search, {
      method: req.method,
      headers,
      body: raw.length ? raw : undefined,
    });
    const text = await r.text();
    return send(res, r.status, text ? JSON.parse(text) : null);
  }

  if (req.method === "GET" && pathname === "/api/session") {
    return send(res, 200, { keyPrefix: apiKey().slice(0, 8), companyId: registry.currentId });
  }

  // "Process a document": ask the service to consume units for one user.
  if (req.method === "POST" && pathname === "/api/consume") {
    const { externalId, units } = await readJson(req);
    // A new requestId per click. A real app would reuse the same id when it retries the same action.
    const r = await metering("POST", "/v1/consume", { body: { requestId: randomUUID(), externalId, units } });
    return send(res, r.status, r.body);
  }

  if (req.method === "GET" && pathname === "/api/companies") {
    if (search.includes("light")) {
      return send(res, 200, { companies: registry.companies.map((c) => ({ id: c.id, name: c.name, current: c.id === registry.currentId, reachable: true })) });
    }
    return send(res, 200, { companies: await Promise.all(registry.companies.map(describeCompany)) });
  }

  if (req.method === "POST" && pathname === "/api/companies/select") {
    const { id } = await readJson(req);
    if (!registry.companies.some((c) => c.id === id)) return send(res, 404, { error: { message: "Unknown company" } });
    registry.currentId = id;
    await saveRegistry();
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/accounts") {
    const r = await createAccount(await readJson(req));
    return send(res, r.status, r.status === 201 ? { account: r.body.account } : r.body);
  }

  // Key rotation: new key -> start using it -> revoke the old one.
  if (req.method === "POST" && pathname === "/api/rotate-key") {
    const oldPrefix = apiKey().slice(0, 8);
    const created = await metering("POST", "/v1/account/api-keys");
    if (created.status !== 201) return send(res, created.status, created.body);
    const keys = (await metering("GET", "/v1/account/api-keys")).body.apiKeys;
    const oldId = keys.find((k) => k.prefix === oldPrefix)?.id;
    current().apiKey = created.body.apiKey.key; // from now on this client uses the new key
    await saveRegistry();
    const revoked = oldId && (await metering("DELETE", `/v1/account/api-keys/${oldId}`));
    return send(res, 200, { keyPrefix: apiKey().slice(0, 8), revokedOld: revoked?.status === 204 });
  }

  // Shows the 401 the service gives for a missing / wrong key.
  if (req.method === "POST" && pathname === "/api/try-key") {
    const { mode } = await readJson(req);
    const wrong = "mk_" + "x".repeat(43);
    const r = await metering("GET", "/v1/account", { key: mode === "wrong" ? wrong : null });
    return send(res, r.status, r.body);
  }

  return send(res, 404, { error: "not found" });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    const file = FILES[url.pathname];
    if (!file) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] + "; charset=utf-8" });
    res.end(await readFile(path.join(PUBLIC_DIR, file)));
  } catch (err) {
    console.error(err);
    send(res, 500, { error: "client error" });
  }
});

await waitForService();
await loadRegistry();
// keep only the companies the service still knows (e.g. drop them if the database was wiped)
const known = (await Promise.all(registry.companies.map(describeCompany))).filter((c) => c.reachable).map((c) => c.id);
registry.companies = registry.companies.filter((c) => known.includes(c.id));
if (!current()) registry.currentId = registry.companies[0]?.id ?? null;
if (!current()) {
  const first = await createAccount({ name: "Docs App (demo)", planId: "demo", seed: true });
  if (first.status !== 201) throw new Error("Could not create the demo account: " + JSON.stringify(first.body));
}
await saveRegistry();
server.listen(PORT, () => console.log(`Example client on http://localhost:${PORT} (${registry.companies.length} company/companies known)`));

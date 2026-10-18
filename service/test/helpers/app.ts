import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { Config } from "../../src/config/env.js";
import { createTestDb, type TestDb } from "./db.js";

export const ADMIN_TOKEN = "test-admin-token";

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Limits = { monthlyLimit: number; maxPerRequest: number };
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Scenario {
  key: string;
  accountId: string;
  accPlanId: string;
  usrPlanId: string;
  /** user id (uuid) by externalId */
  ids: Record<string, string>;
}

export interface TestApp {
  app: FastifyInstance;
  t: TestDb;
  admin: { "x-admin-token": string };
  /** Moves the service's clock to `date` (UTC). `setNow(null)` goes back to the real time. */
  setNow: (date: Date | string | null) => void;
  /** One API call as the account that owns `key`: the status and the parsed JSON body (null when empty). */
  call: (method: Method, url: string, key: string, payload?: object) => Promise<{ status: number; body: Json }>;
  /** POST /v1/consume */
  consume: (key: string, requestId: string, externalId: string, units: number) => Promise<{ status: number; body: Json }>;
  /** GET /v1/usage -> the `usage` object */
  usage: (key: string, query?: string) => Promise<Json>;
  /** A fresh account on its own account plan and user plan with the given limits, plus users on that user plan. */
  scenario: (account: Limits, user: Limits, users?: string[]) => Promise<Scenario>;
  close: () => Promise<void>;
}

let scenarioCount = 0;

/** A real app on a brand-new migrated + seeded database. `setup` runs before the app is started (add test-only routes there). */
export async function createTestApp(setup?: (app: FastifyInstance) => void): Promise<TestApp> {
  const t = await createTestDb();
  const config: Config = { DATABASE_URL: "unused", ADMIN_TOKEN, PORT: 3000, DB_POOL_MAX: 5, WEB_CONCURRENCY: 1 };
  let fixedNow: Date | null = null;
  const app = buildApp({ config, pool: t.pool, db: t.db, now: () => fixedNow ?? new Date() });
  setup?.(app);
  await app.ready();

  const admin = { "x-admin-token": ADMIN_TOKEN };

  const call: TestApp["call"] = async (method, url, key, payload) => {
    const res = await app.inject({ method, url, headers: { "x-api-key": key }, payload });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as Json };
  };

  const must = (what: string, got: number, wanted: number, body: unknown) => {
    if (got !== wanted) throw new Error(`${what}: expected ${wanted}, got ${got} ${JSON.stringify(body)}`);
  };

  const scenario: TestApp["scenario"] = async (account, user, users = ["u1"]) => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: admin,
      payload: { name: `scenario-${++scenarioCount}` },
    });
    must("create account", created.statusCode, 201, created.body);
    const key = created.json().apiKey.key as string;
    const accountId = created.json().account.id as string;

    const accPlan = await call("POST", "/v1/plans", key, { name: "acc", scope: "account", ...account });
    const usrPlan = await call("POST", "/v1/plans", key, { name: "usr", scope: "user", ...user });
    must("create account plan", accPlan.status, 201, accPlan.body);
    must("create user plan", usrPlan.status, 201, usrPlan.body);
    const assigned = await call("PUT", "/v1/account/plan", key, { planId: accPlan.body.plan.id });
    must("assign account plan", assigned.status, 200, assigned.body);

    const ids: Record<string, string> = {};
    for (const externalId of users) {
      const u = await call("POST", "/v1/users", key, { externalId, planId: usrPlan.body.plan.id });
      must(`create user ${externalId}`, u.status, 201, u.body);
      ids[externalId] = u.body.user.id;
    }
    return { key, accountId, accPlanId: accPlan.body.plan.id, usrPlanId: usrPlan.body.plan.id, ids };
  };

  return {
    app,
    t,
    admin,
    setNow: (date) => {
      fixedNow = date === null ? null : new Date(date);
    },
    call,
    consume: (key, requestId, externalId, units) => call("POST", "/v1/consume", key, { requestId, externalId, units }),
    usage: async (key, query = "") => (await call("GET", `/v1/usage${query}`, key)).body.usage as Json,
    scenario,
    close: async () => {
      await app.close();
      await t.drop();
    },
  };
}
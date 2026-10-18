import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../helpers/app.js";

/**
 * Concurrency guarantees of POST /v1/consume. Everything is fired with Promise.all against a real PostgreSQL,
 * so the requests really overlap (the test pool has 5 connections, the DB does the serialising).
 */
let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});

afterAll(async () => {
  await h.close();
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function post(url: string, headers: Record<string, string>, payload: object) {
  const res = await h.app.inject({ method: "POST", url, headers, payload });
  return { status: res.statusCode, body: res.json() as Json };
}

async function send(method: "PATCH" | "PUT", url: string, key: string, payload: object) {
  const res = await h.app.inject({ method, url, headers: { "x-api-key": key }, payload });
  return { status: res.statusCode, body: res.json() as Json };
}

async function setup(opts: {
  accountPlan: { monthlyLimit: number; maxPerRequest: number };
  userPlan: { monthlyLimit: number; maxPerRequest: number };
  users: number;
}) {
  const acc = await post("/v1/accounts", h.admin, { name: `conc-${Math.random().toString(36).slice(2)}` });
  const key = acc.body.apiKey.key as string;
  const accountId = acc.body.account.id as string;
  const headers = { "x-api-key": key };

  const accPlan = await post("/v1/plans", headers, { name: "acc", scope: "account", ...opts.accountPlan });
  const usrPlan = await post("/v1/plans", headers, { name: "usr", scope: "user", ...opts.userPlan });
  await send("PUT", "/v1/account/plan", key, { planId: accPlan.body.plan.id });

  const users: { id: string; externalId: string }[] = [];
  for (let i = 0; i < opts.users; i++) {
    const u = await post("/v1/users", headers, { externalId: `u${i}`, planId: usrPlan.body.plan.id });
    users.push(u.body.user);
  }
  return {
    key,
    headers,
    accountId,
    users,
    accountPlanId: accPlan.body.plan.id as string,
    userPlanId: usrPlan.body.plan.id as string,
  };
}

async function counters(accountId: string) {
  const r = await h.t.pool.query<{ user_id: string | null; used: number }>(
    "SELECT user_id, used FROM usage_counters WHERE account_id = $1",
    [accountId],
  );
  return {
    account: r.rows.find((c) => c.user_id === null)?.used ?? 0,
    byUser: new Map(r.rows.filter((c) => c.user_id !== null).map((c) => [c.user_id as string, c.used])),
  };
}

describe("consume under concurrency", () => {
  it("never exceeds a user's monthly allowance (60 parallel requests of 10 units against 200)", async () => {
    const s = await setup({
      accountPlan: { monthlyLimit: 100000, maxPerRequest: 1000 },
      userPlan: { monthlyLimit: 200, maxPerRequest: 50 },
      users: 1,
    });

    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        post("/v1/consume", s.headers, { requestId: `req-${i}`, externalId: "u0", units: 10 }),
      ),
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    const accepted = results.filter((r) => r.body.accepted);
    expect(accepted).toHaveLength(20);
    expect(results.filter((r) => !r.body.accepted).every((r) => r.body.rejection.scope === "user")).toBe(
      true,
    );

    const c = await counters(s.accountId);
    expect(c.byUser.get(s.users[0]!.id)).toBe(200);
    expect(c.account).toBe(200);

    // the "remaining" values handed to accepted callers are all different: nobody saw the same state
    const remainders = new Set(accepted.map((r) => r.body.remaining.user));
    expect(remainders.size).toBe(20);
  });

  it("never exceeds the shared company allowance when many employees consume at once", async () => {
    const s = await setup({
      accountPlan: { monthlyLimit: 300, maxPerRequest: 50 },
      userPlan: { monthlyLimit: 10000, maxPerRequest: 50 },
      users: 10,
    });

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        post("/v1/consume", s.headers, { requestId: `r-${i}`, externalId: `u${i % 10}`, units: 10 }),
      ),
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.accepted)).toHaveLength(30);
    expect(results.filter((r) => !r.body.accepted).every((r) => r.body.rejection.scope === "account")).toBe(
      true,
    );

    const c = await counters(s.accountId);
    expect(c.account).toBe(300);
    expect([...c.byUser.values()].reduce((a, b) => a + b, 0)).toBe(300);
  });

  it("keeps both levels exact when the user limits AND the shared account limit are reached at the same time", async () => {
    // 5 users may take 30 each (150 in total) but the account only has 100: both kinds of limit bind in the same burst.
    const s = await setup({
      accountPlan: { monthlyLimit: 100, maxPerRequest: 50 },
      userPlan: { monthlyLimit: 30, maxPerRequest: 10 },
      users: 5,
    });

    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        post("/v1/consume", s.headers, { requestId: `r-${i}`, externalId: `u${i % 5}`, units: 5 }),
      ),
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.accepted)).toHaveLength(20); // exactly the 100 units of the account
    expect(
      results.filter((r) => !r.body.accepted).every((r) => r.body.rejection.rule === "monthly_allowance"),
    ).toBe(true);

    const c = await counters(s.accountId);
    expect(c.account).toBe(100);
    expect([...c.byUser.values()].reduce((a, b) => a + b, 0)).toBe(100); // account total == sum of its users
    expect([...c.byUser.values()].every((used) => used <= 30)).toBe(true); // nobody went over a personal limit
  });

  it("applies a request once when the same requestId is sent in parallel", async () => {
    const s = await setup({
      accountPlan: { monthlyLimit: 1000, maxPerRequest: 100 },
      userPlan: { monthlyLimit: 1000, maxPerRequest: 100 },
      users: 1,
    });

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        post("/v1/consume", s.headers, { requestId: "same-id", externalId: "u0", units: 40 }),
      ),
    );

    expect(results.every((r) => r.status === 200 && r.body.accepted)).toBe(true);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.remaining.user)).size).toBe(1);

    const c = await counters(s.accountId);
    expect(c.account).toBe(40);
    const rows = await h.t.pool.query("SELECT 1 FROM consume_requests WHERE account_id = $1", [s.accountId]);
    expect(rows.rowCount).toBe(1);
  });

  it("answers a parallel retry of a REJECTED request with the same rejection and records it once", async () => {
    const s = await setup({
      accountPlan: { monthlyLimit: 1000, maxPerRequest: 100 },
      userPlan: { monthlyLimit: 1000, maxPerRequest: 20 },
      users: 1,
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        post("/v1/consume", s.headers, { requestId: "too-big", externalId: "u0", units: 30 }),
      ),
    );

    expect(results.every((r) => r.status === 200 && !r.body.accepted)).toBe(true);
    expect(results.every((r) => r.body.rejection.rule === "max_per_request")).toBe(true);
    const c = await counters(s.accountId);
    expect(c.account).toBe(0);
  });

  it("rejects the same requestId used with another payload, also in parallel", async () => {
    const s = await setup({
      accountPlan: { monthlyLimit: 1000, maxPerRequest: 100 },
      userPlan: { monthlyLimit: 1000, maxPerRequest: 100 },
      users: 1,
    });

    const results = await Promise.all(
      [10, 20, 30, 40].map((units) =>
        post("/v1/consume", s.headers, { requestId: "clash", externalId: "u0", units }),
      ),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.error.code === "idempotency_key_reused"),
    ).toBe(true);
    const winner = results.find((r) => r.status === 200)!;
    expect((await counters(s.accountId)).account).toBe(winner.body.units);
  });

  it("keeps two companies completely independent while they share a predefined plan", async () => {
    const a = await post("/v1/accounts", h.admin, { name: "iso-a" });
    const b = await post("/v1/accounts", h.admin, { name: "iso-b" });
    const ha = { "x-api-key": a.body.apiKey.key as string };
    const hb = { "x-api-key": b.body.apiKey.key as string };
    await post("/v1/users", ha, { externalId: "same" });
    await post("/v1/users", hb, { externalId: "same" });

    const results = await Promise.all(
      Array.from({ length: 80 }, (_, i) =>
        post("/v1/consume", i % 2 === 0 ? ha : hb, { requestId: `r-${i}`, externalId: "same", units: 10 }),
      ),
    );

    // Basic user plan = 1000/month, 20 per request: all 40 + 40 requests of 10 fit
    expect(results.every((r) => r.body.accepted)).toBe(true);
    expect((await counters(a.body.account.id)).account).toBe(400);
    expect((await counters(b.body.account.id)).account).toBe(400);
  });
});

describe("plan changes while consuming", () => {
  it("editing a plan during a burst neither deadlocks nor lets any request through on a stale limit", async () => {
    const s = await setup({
      accountPlan: { monthlyLimit: 100000, maxPerRequest: 1000 },
      userPlan: { monthlyLimit: 100000, maxPerRequest: 100 },
      users: 3,
    });

    const consumes = Array.from({ length: 60 }, (_, i) =>
      post("/v1/consume", s.headers, { requestId: `e-${i}`, externalId: `u${i % 3}`, units: 50 }),
    );
    const edits = Array.from({ length: 10 }, (_, i) =>
      send("PATCH", `/v1/plans/${s.userPlanId}`, s.key, { maxPerRequest: i % 2 === 0 ? 10 : 100 }),
    );

    const [results, editResults] = await Promise.all([Promise.all(consumes), Promise.all(edits)]);

    expect(editResults.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.status === 200)).toBe(true);

    // Every decision must be consistent with the limit that was recorded WITH it.
    const rows = await h.t.pool.query<{ units: number; accepted: boolean; user_max_per_request: number }>(
      "SELECT units, accepted, user_max_per_request FROM consume_requests WHERE account_id = $1",
      [s.accountId],
    );
    expect(rows.rowCount).toBe(60);
    for (const row of rows.rows) {
      expect(row.accepted).toBe(row.units <= row.user_max_per_request);
    }
    // ...and the counters equal exactly what was accepted
    const acceptedUnits = rows.rows.filter((r) => r.accepted).reduce((n, r) => n + r.units, 0);
    expect((await counters(s.accountId)).account).toBe(acceptedUnits);
  });

  it("switching a user's plan during a burst yields only 200 or a retryable 409, and counters stay exact", async () => {
    const s = await setup({
      accountPlan: { monthlyLimit: 100000, maxPerRequest: 1000 },
      userPlan: { monthlyLimit: 100000, maxPerRequest: 100 },
      users: 1,
    });
    const other = await post("/v1/plans", s.headers, {
      name: "other",
      scope: "user",
      monthlyLimit: 100000,
      maxPerRequest: 100,
    });

    const consumes = Array.from({ length: 40 }, (_, i) =>
      post("/v1/consume", s.headers, { requestId: `s-${i}`, externalId: "u0", units: 5 }),
    );
    const switches = Array.from({ length: 10 }, (_, i) =>
      send("PUT", `/v1/users/${s.users[0]!.id}/plan`, s.key, {
        planId: i % 2 === 0 ? other.body.plan.id : s.userPlanId,
      }),
    );

    const [results, sw] = await Promise.all([Promise.all(consumes), Promise.all(switches)]);

    expect(sw.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect([200, 409]).toContain(r.status);
      if (r.status === 409) expect(r.body.error.code).toBe("user_plan_changed");
    }
    const ok = results.filter((r) => r.status === 200 && r.body.accepted).length;
    expect((await counters(s.accountId)).account).toBe(ok * 5);

    // a 409 left nothing behind, so retrying the same requestId works
    for (const [i, r] of results.entries()) {
      if (r.status !== 409) continue;
      const retry = await post("/v1/consume", s.headers, { requestId: `s-${i}`, externalId: "u0", units: 5 });
      expect(retry.status).toBe(200);
      expect(retry.body.accepted).toBe(true);
    }
  });

  it("archiving a plan while consuming never deadlocks (archive is refused while in use)", async () => {
    const s = await setup({
      accountPlan: { monthlyLimit: 100000, maxPerRequest: 1000 },
      userPlan: { monthlyLimit: 100000, maxPerRequest: 100 },
      users: 2,
    });

    const consumes = Array.from({ length: 30 }, (_, i) =>
      post("/v1/consume", s.headers, { requestId: `a-${i}`, externalId: `u${i % 2}`, units: 1 }),
    );
    const archive = h.app.inject({ method: "DELETE", url: `/v1/plans/${s.userPlanId}`, headers: s.headers });

    const [results, arch] = await Promise.all([Promise.all(consumes), archive]);

    expect(arch.statusCode).toBe(409);
    expect(results.every((r) => r.status === 200 && r.body.accepted)).toBe(true);
  });
});
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/config/database.js";
import { ConflictError, NotFoundError } from "../../src/errors/app-error.js";
import { consume as consumeService } from "../../src/services/consume.service.js";
import { createTestApp, type TestApp } from "../helpers/app.js";

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});

afterEach(() => {
  h.setNow(null);
});

afterAll(async () => {
  await h.close();
});

const sql = <T extends Record<string, unknown> = Record<string, unknown>>(
  query: string,
  params: unknown[] = [],
) => h.t.pool.query<T>(query, params);

async function newAccount(name = "consume-test") {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: h.admin,
    payload: { name },
  });

  expect(res.statusCode).toBe(201);

  return res.json() as {
    account: { id: string };
    apiKey: { key: string };
  };
}

async function createUser(key: string, externalId = "employee-001") {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/users",
    headers: { "x-api-key": key },
    payload: { externalId },
  });

  expect(res.statusCode).toBe(201);

  return res.json().user as {
    id: string;
    externalId: string;
  };
}

function consumeRequest(key: string | undefined, payload: object) {
  return h.app.inject({
    method: "POST",
    url: "/v1/consume",
    headers: key === undefined ? {} : { "x-api-key": key },
    payload,
  });
}

async function getCounters(accountId: string, windowStart: string) {
  const result = await sql<{
    user_id: string | null;
    used: number;
  }>(
    `SELECT user_id, used
     FROM usage_counters
     WHERE account_id = $1 AND window_start = $2`,
    [accountId, windowStart],
  );

  return result.rows;
}

describe("POST /v1/consume — authentication and validation", () => {
  it("rejects a missing API key", async () => {
    const res = await consumeRequest(undefined, {
      requestId: "auth-test",
      externalId: "employee-001",
      units: 1,
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects invalid units", async () => {
    const { apiKey } = await newAccount("consume-invalid-units");

    const res = await consumeRequest(apiKey.key, {
      requestId: "invalid-units",
      externalId: "employee-001",
      units: 0,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});

describe("POST /v1/consume — usage metering", () => {
  it("accepts a request and increments both counters", async () => {
    const { account, apiKey } = await newAccount("consume-accepted");
    const user = await createUser(apiKey.key, "accepted-employee");

    const res = await consumeRequest(apiKey.key, {
      requestId: "accepted-request",
      externalId: user.externalId,
      units: 5,
    });

    expect(res.statusCode).toBe(200);

    const result = res.json();

    expect(result).toMatchObject({
      requestId: "accepted-request",
      accepted: true,
      units: 5,
      rejection: null,
    });

    const counters = await getCounters(account.id, result.windowStart);

    expect(counters).toHaveLength(2);
    expect(counters.find((counter) => counter.user_id === null)?.used).toBe(5);
    expect(counters.find((counter) => counter.user_id === user.id)?.used).toBe(5);
  });

  it("rejects a request over the Basic per-request limit without consuming units", async () => {
    const { account, apiKey } = await newAccount("consume-rejected");
    const user = await createUser(apiKey.key, "rejected-employee");

    const res = await consumeRequest(apiKey.key, {
      requestId: "rejected-request",
      externalId: user.externalId,
      units: 21,
    });

    expect(res.statusCode).toBe(200);

    const result = res.json();

    expect(result.accepted).toBe(false);
    expect(result.rejection).toMatchObject({
      scope: "user",
      rule: "max_per_request",
      limit: 20,
    });

    const counters = await getCounters(account.id, result.windowStart);

    expect(counters).toHaveLength(2);
    expect(counters.every((counter) => counter.used === 0)).toBe(true);
  });

  it("returns the original result for an identical retry without double counting", async () => {
    const { account, apiKey } = await newAccount("consume-retry");
    const user = await createUser(apiKey.key, "retry-employee");

    const payload = {
      requestId: "retry-request",
      externalId: user.externalId,
      units: 5,
    };

    const first = await consumeRequest(apiKey.key, payload);
    const second = await consumeRequest(apiKey.key, payload);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().replayed).toBe(false);
    expect(second.json().replayed).toBe(true);
    expect({ ...second.json(), replayed: false }).toEqual(first.json());

    const counters = await getCounters(account.id, first.json().windowStart);

    expect(counters).toHaveLength(2);
    expect(counters.every((counter) => counter.used === 5)).toBe(true);
  });

  it("rejects reusing a requestId with a different payload", async () => {
    const { apiKey } = await newAccount("consume-key-conflict");
    const user = await createUser(apiKey.key, "conflict-employee");

    const first = await consumeRequest(apiKey.key, {
      requestId: "same-request-id",
      externalId: user.externalId,
      units: 5,
    });

    expect(first.statusCode).toBe(200);

    const second = await consumeRequest(apiKey.key, {
      requestId: "same-request-id",
      externalId: user.externalId,
      units: 6,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("idempotency_key_reused");
  });

  it("does not allow concurrent requests to exceed the shared account allowance", async () => {
    const { account, apiKey } = await newAccount("consume-concurrency");

    const userA = await createUser(apiKey.key, "concurrent-employee-a");
    const userB = await createUser(apiKey.key, "concurrent-employee-b");

    const planResult = await sql<{
      monthly_limit: number;
      max_per_request: number;
    }>(
      `SELECT p.monthly_limit, p.max_per_request
        FROM accounts a
        JOIN plans p ON p.id = a.plan_id
        WHERE a.id = $1`,
      [account.id],
    );

    expect(planResult.rows).toHaveLength(1);

    const accountPlan = planResult.rows[0]!;
    expect(accountPlan.monthly_limit).toBeGreaterThan(0);
    expect(accountPlan.max_per_request).toBeGreaterThanOrEqual(1);

    const now = new Date();
    const windowStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;

    // Leave room for exactly one more unit in the shared account allowance.
    await sql(
      `INSERT INTO usage_counters
       (account_id, user_id, window_type, window_start, used)
     VALUES ($1, NULL, 'month', $2, $3)
     ON CONFLICT (account_id, user_id, window_type, window_start)
     DO UPDATE SET used = EXCLUDED.used, updated_at = now()`,
      [account.id, windowStart, accountPlan.monthly_limit - 1],
    );

    const [resA, resB] = await Promise.all([
      consumeRequest(apiKey.key, {
        requestId: "concurrent-request-a",
        externalId: userA.externalId,
        units: 1,
      }),
      consumeRequest(apiKey.key, {
        requestId: "concurrent-request-b",
        externalId: userB.externalId,
        units: 1,
      }),
    ]);

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);

    const results = [resA.json(), resB.json()];

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toHaveLength(1);

    const rejected = results.find((result) => !result.accepted)!;

    expect(rejected.rejection).toMatchObject({
      scope: "account",
      rule: "monthly_allowance",
    });

    const counters = await getCounters(account.id, windowStart);
    const accountCounter = counters.find((counter) => counter.user_id === null);

    expect(accountCounter?.used).toBe(accountPlan.monthly_limit);

    const userCounterA = counters.find((counter) => counter.user_id === userA.id);
    const userCounterB = counters.find((counter) => counter.user_id === userB.id);

    expect([userCounterA?.used, userCounterB?.used].sort()).toEqual([0, 1]);
  });
});

describe("POST /v1/consume — months", () => {
  it("an allowance used up in one month is available again the next month", async () => {
    const s = await h.scenario({ monthlyLimit: 1000, maxPerRequest: 100 }, { monthlyLimit: 100, maxPerRequest: 50 });

    h.setNow("2026-03-10T12:00:00Z");
    expect((await h.consume(s.key, "m3-a", "u1", 50)).body.accepted).toBe(true);
    expect((await h.consume(s.key, "m3-b", "u1", 50)).body.accepted).toBe(true);
    const blocked = await h.consume(s.key, "m3-c", "u1", 1);
    expect(blocked.body).toMatchObject({
      accepted: false,
      remaining: { user: 0 },
      rejection: { scope: "user", rule: "monthly_allowance", limit: 100 },
    });

    h.setNow("2026-04-01T00:00:00Z");
    const april = await h.consume(s.key, "m4-a", "u1", 50);
    expect(april.body).toMatchObject({ accepted: true, windowStart: "2026-04-01", remaining: { user: 50 } });
  });

  it("a retry after the month changed returns the original decision and is not counted again", async () => {
    const s = await h.scenario({ monthlyLimit: 1000, maxPerRequest: 100 }, { monthlyLimit: 100, maxPerRequest: 50 });

    h.setNow("2026-07-31T23:59:00Z");
    const first = await h.consume(s.key, "late-call", "u1", 25);
    expect(first.body).toMatchObject({ accepted: true, replayed: false, windowStart: "2026-07-01" });

    h.setNow("2026-08-01T00:01:00Z");
    const retry = await h.consume(s.key, "late-call", "u1", 25);
    expect(retry.body).toMatchObject({ accepted: true, replayed: true, windowStart: "2026-07-01" });

    expect((await h.usage(s.key, "?month=2026-08")).account.used).toBe(0);
    expect((await h.usage(s.key, "?month=2026-07")).account.used).toBe(25);
  });
});

describe("POST /v1/consume — retries", () => {
  it("a rejected request stays rejected when retried with the same requestId; a new requestId is decided afresh", async () => {
    const s = await h.scenario({ monthlyLimit: 1000, maxPerRequest: 100 }, { monthlyLimit: 1000, maxPerRequest: 10 });

    const first = await h.consume(s.key, "too-big", "u1", 20);
    expect(first.body).toMatchObject({
      accepted: false,
      replayed: false,
      rejection: { scope: "user", rule: "max_per_request", limit: 10 },
    });

    await h.call("PATCH", `/v1/plans/${s.usrPlanId}`, s.key, { maxPerRequest: 50 }); // now 20 would fit

    const retry = await h.consume(s.key, "too-big", "u1", 20);
    expect(retry.body).toMatchObject({ accepted: false, replayed: true, rejection: { scope: "user", rule: "max_per_request" } });

    const fresh = await h.consume(s.key, "too-big-2", "u1", 20);
    expect(fresh.body).toMatchObject({ accepted: true, replayed: false });
  });

  it("a replay returns the remaining values of the ORIGINAL decision and counts nothing", async () => {
    const s = await h.scenario({ monthlyLimit: 1000, maxPerRequest: 100 }, { monthlyLimit: 100, maxPerRequest: 50 });

    const original = await h.consume(s.key, "r1", "u1", 10);
    await h.consume(s.key, "r2", "u1", 10);
    const replay = await h.consume(s.key, "r1", "u1", 10);

    expect(original.body.remaining).toEqual({ account: 990, user: 90 });
    expect(replay.body).toMatchObject({ replayed: true, accepted: true, remaining: { account: 990, user: 90 } });
    expect((await h.usage(s.key, "?externalId=u1")).user.used).toBe(20);
  });

  it("the same requestId is independent between two accounts", async () => {
    const a = await h.scenario({ monthlyLimit: 1000, maxPerRequest: 100 }, { monthlyLimit: 100, maxPerRequest: 50 });
    const b = await h.scenario({ monthlyLimit: 1000, maxPerRequest: 100 }, { monthlyLimit: 100, maxPerRequest: 50 });

    const ra = await h.consume(a.key, "shared-id", "u1", 10);
    const rb = await h.consume(b.key, "shared-id", "u1", 30);

    expect(ra.body).toMatchObject({ replayed: false, units: 10 });
    expect(rb.body).toMatchObject({ replayed: false, units: 30 });
  });
});

describe("POST /v1/consume — account isolation and unknown users", () => {
  it("cannot consume for a user that belongs to ANOTHER account, and nothing is recorded anywhere", async () => {
    const a = await h.scenario({ monthlyLimit: 1000, maxPerRequest: 100 }, { monthlyLimit: 100, maxPerRequest: 50 }, ["only-in-a"]);
    const b = await h.scenario({ monthlyLimit: 1000, maxPerRequest: 100 }, { monthlyLimit: 100, maxPerRequest: 50 }, ["b-user"]);

    const r = await h.consume(b.key, "steal", "only-in-a", 10);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("user_not_found");

    expect((await h.usage(a.key, "?externalId=only-in-a")).user.used).toBe(0);
    expect((await h.usage(b.key)).account.used).toBe(0);
    expect((await h.call("GET", "/v1/usage/history", a.key)).body.history.pagination.total).toBe(0);
    expect((await h.call("GET", "/v1/usage/history", b.key)).body.history.pagination.total).toBe(0);
  });

  it("an unknown user and a deleted user are both 404 and consume nothing", async () => {
    const s = await h.scenario({ monthlyLimit: 1000, maxPerRequest: 100 }, { monthlyLimit: 100, maxPerRequest: 50 });

    expect((await h.consume(s.key, "ghost", "nobody", 1)).status).toBe(404);

    await h.consume(s.key, "before-delete", "u1", 40);
    expect((await h.call("DELETE", `/v1/users/${s.ids.u1}`, s.key)).status).toBe(204);

    const afterDelete = await h.consume(s.key, "after-delete", "u1", 1);
    expect(afterDelete.status).toBe(404);
    expect(afterDelete.body.error.code).toBe("user_not_found");

    // what the deleted user consumed before stays in the shared account counter
    expect((await h.usage(s.key)).account.used).toBe(40);
  });
});

describe("consume service — internal retry when the user's plan changes under the request (no database)", () => {
  const input = { requestId: "r", externalId: "u", units: 1 };
  const planChanged = () => new ConflictError("user_plan_changed", "The user's plan changed during this request; please retry");
  const fakeDb = (transaction: ReturnType<typeof vi.fn>) => ({ transaction }) as unknown as Db;

  it("starts over and succeeds when the plan only changed once", async () => {
    const transaction = vi.fn().mockRejectedValueOnce(planChanged()).mockResolvedValueOnce({ accepted: true });

    await expect(consumeService(fakeDb(transaction), "acc", input)).resolves.toEqual({ accepted: true });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("gives up with the same 409 after 3 attempts", async () => {
    const transaction = vi.fn().mockImplementation(async () => {
      throw planChanged();
    });

    await expect(consumeService(fakeDb(transaction), "acc", input)).rejects.toMatchObject({
      statusCode: 409,
      code: "user_plan_changed",
    });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("does not retry any other error", async () => {
    const notFound = vi.fn().mockRejectedValue(new NotFoundError("user_not_found", "User not found"));
    await expect(consumeService(fakeDb(notFound), "acc", input)).rejects.toMatchObject({ code: "user_not_found" });
    expect(notFound).toHaveBeenCalledTimes(1);

    const reused = vi.fn().mockRejectedValue(new ConflictError("idempotency_key_reused", "x"));
    await expect(consumeService(fakeDb(reused), "acc", input)).rejects.toMatchObject({ code: "idempotency_key_reused" });
    expect(reused).toHaveBeenCalledTimes(1);
  });
});

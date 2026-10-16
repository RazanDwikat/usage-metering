import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../helpers/app.js";

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
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

function consumeRequest(
  key: string | undefined,
  payload: object,
) {
  return h.app.inject({
    method: "POST",
    url: "/v1/consume",
    headers: key === undefined ? {} : { "x-api-key": key },
    payload,
  });
}

async function getCounters(
  accountId: string,
  windowStart: string,
) {
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
    expect(
      counters.find((counter) => counter.user_id === null)?.used,
    ).toBe(5);
    expect(
      counters.find((counter) => counter.user_id === user.id)?.used,
    ).toBe(5);
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
    expect(second.json()).toEqual(first.json());

    const counters = await getCounters(
      account.id,
      first.json().windowStart,
    );

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
    }>(`SELECT p.monthly_limit, p.max_per_request
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
   const windowStart =
    `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;

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

   const userCounterA = counters.find(
    (counter) => counter.user_id === userA.id,
  );
   const userCounterB = counters.find(
    (counter) => counter.user_id === userB.id,
  );

   expect([userCounterA?.used, userCounterB?.used].sort()).toEqual([0, 1]);
});

});

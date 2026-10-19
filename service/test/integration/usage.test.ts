import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

async function newAccount(name = "usage-test") {
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

async function createUser(key: string, externalId: string) {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/users",
    headers: { "x-api-key": key },
    payload: { externalId },
  });

  expect(res.statusCode).toBe(201);
  return res.json().user as { id: string; externalId: string };
}

function usageRequest(key: string | undefined, query = "") {
  return h.app.inject({
    method: "GET",
    url: `/v1/usage${query}`,
    headers: key === undefined ? {} : { "x-api-key": key },
  });
}

describe("GET /v1/usage — authentication and validation", () => {
  it("rejects a missing API key", async () => {
    const res = await usageRequest(undefined);

    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid month format", async () => {
    const { apiKey } = await newAccount("usage-invalid-month");

    const res = await usageRequest(apiKey.key, "?month=2026-13");

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});

describe("GET /v1/usage — usage summary", () => {
  it("returns zero usage when no counters exist", async () => {
    const { apiKey } = await newAccount("usage-empty");

    const res = await usageRequest(apiKey.key);

    expect(res.statusCode).toBe(200);

    const result = res.json().usage;

    expect(result.period).toMatch(/^\d{4}-\d{2}$/);
    expect(result.account).toMatchObject({
      used: 0,
      remaining: result.account.limit,
    });
    expect(result.user).toBeUndefined();
  });

  it("returns account and user usage after a successful consume", async () => {
    const { apiKey } = await newAccount("usage-after-consume");
    const user = await createUser(apiKey.key, "usage-employee");

    const consumeRes = await h.app.inject({
      method: "POST",
      url: "/v1/consume",
      headers: { "x-api-key": apiKey.key },
      payload: {
        requestId: "usage-summary-request",
        externalId: user.externalId,
        units: 5,
      },
    });

    expect(consumeRes.statusCode).toBe(200);
    expect(consumeRes.json().accepted).toBe(true);

    const period = consumeRes.json().windowStart.slice(0, 7);

    const res = await usageRequest(
      apiKey.key,
      `?month=${period}&externalId=${encodeURIComponent(user.externalId)}`,
    );

    expect(res.statusCode).toBe(200);

    expect(res.json().usage).toMatchObject({
      period,
      account: {
        used: 5,
        remaining: expect.any(Number),
      },
      user: {
        externalId: user.externalId,
        used: 5,
        remaining: expect.any(Number),
      },
    });
  });

  it("rejects an unknown user", async () => {
    const { apiKey } = await newAccount("usage-unknown-user");

    const res = await usageRequest(apiKey.key, "?externalId=does-not-exist");

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("user_not_found");
  });

  it("does not create or modify counters when reading usage", async () => {
    const { account, apiKey } = await newAccount("usage-read-only");
    const user = await createUser(apiKey.key, "usage-read-only-employee");

    const before = await sql<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM usage_counters
       WHERE account_id = $1`,
      [account.id],
    );

    const res = await usageRequest(apiKey.key, `?externalId=${encodeURIComponent(user.externalId)}`);

    expect(res.statusCode).toBe(200);

    const after = await sql<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM usage_counters
       WHERE account_id = $1`,
      [account.id],
    );

    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});

describe("GET /v1/usage — UTC month boundaries", () => {
  it("counts a request in the month it is processed in, and each new month starts at zero", async () => {
    const s = await h.scenario({ monthlyLimit: 1000, maxPerRequest: 100 }, { monthlyLimit: 100, maxPerRequest: 50 });

    h.setNow("2026-01-31T23:59:59.999Z"); // last millisecond of January
    const jan = await h.consume(s.key, "jan-1", "u1", 40);
    expect(jan.status).toBe(200);
    expect(jan.body).toMatchObject({ accepted: true, windowStart: "2026-01-01", remaining: { account: 960, user: 60 } });

    h.setNow("2026-02-01T00:00:00.000Z"); // first millisecond of February
    const feb = await h.consume(s.key, "feb-1", "u1", 10);
    expect(feb.body).toMatchObject({ accepted: true, windowStart: "2026-02-01", remaining: { account: 990, user: 90 } });

    
    const current = await h.usage(s.key, "?externalId=u1");
    expect(current.period).toBe("2026-02");
    expect(current.account).toMatchObject({ used: 10, remaining: 990 });
    expect(current.user).toMatchObject({ used: 10, remaining: 90 });

   
    const past = await h.usage(s.key, "?month=2026-01&externalId=u1");
    expect(past.account).toMatchObject({ used: 40, remaining: 960 });
    expect(past.user).toMatchObject({ used: 40, remaining: 60 });
  });
});

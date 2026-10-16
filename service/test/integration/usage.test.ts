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

function usageRequest(
  key: string | undefined,
  query = "",
) {
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

    const res = await usageRequest(
      apiKey.key,
      "?externalId=does-not-exist",
    );

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

    const res = await usageRequest(
      apiKey.key,
      `?externalId=${encodeURIComponent(user.externalId)}`,
    );

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

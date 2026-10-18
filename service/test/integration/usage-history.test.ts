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

async function newAccount(name: string) {
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

  return res.json().user as {
    id: string;
    externalId: string;
  };
}

async function consume(key: string, externalId: string, requestId: string, units: number) {
  return h.app.inject({
    method: "POST",
    url: "/v1/consume",
    headers: { "x-api-key": key },
    payload: { requestId, externalId, units },
  });
}

function historyRequest(key: string | undefined, query = "") {
  return h.app.inject({
    method: "GET",
    url: `/v1/usage/history${query}`,
    headers: key === undefined ? {} : { "x-api-key": key },
  });
}

describe("GET /v1/usage/history — authentication and validation", () => {
  it("rejects a missing API key", async () => {
    const res = await historyRequest(undefined);

    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid month", async () => {
    const { apiKey } = await newAccount("history-invalid-month");

    const res = await historyRequest(apiKey.key, "?month=2026-13");

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});

describe("GET /v1/usage/history — request history", () => {
  it("returns accepted consume requests with their recorded details", async () => {
    const { apiKey } = await newAccount("history-accepted");
    const user = await createUser(apiKey.key, "history-employee");

    const consumeRes = await consume(apiKey.key, user.externalId, "history-accepted-request", 5);

    expect(consumeRes.statusCode).toBe(200);
    expect(consumeRes.json().accepted).toBe(true);

    const period = consumeRes.json().windowStart.slice(0, 7);

    const res = await historyRequest(apiKey.key, `?month=${period}`);

    expect(res.statusCode).toBe(200);

    const result = res.json().history;

    expect(result.period).toBe(period);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      requestId: "history-accepted-request",
      externalId: user.externalId,
      units: 5,
      accepted: true,
      accountMonthlyLimit: expect.any(Number),
      accountMaxPerRequest: expect.any(Number),
      userMonthlyLimit: expect.any(Number),
      userMaxPerRequest: expect.any(Number),
      rejection: null, // same field as POST /v1/consume: null when accepted
    });
    expect(result.items[0].rejection).toEqual(consumeRes.json().rejection);
    expect(result.pagination).toMatchObject({
      limit: 20,
      offset: 0,
      returned: 1,
    });
  });

  it("includes rejected consume requests and their rejection reason", async () => {
    const { apiKey } = await newAccount("history-rejected");
    const user = await createUser(apiKey.key, "history-rejected-employee");

    // The default user plan has a maximum per-request limit.
    // A deliberately oversized request should be rejected.
    const consumeRes = await consume(apiKey.key, user.externalId, "history-rejected-request", 1_000_000);

    expect(consumeRes.statusCode).toBe(200);
    expect(consumeRes.json().accepted).toBe(false);

    const period = consumeRes.json().windowStart.slice(0, 7);

    const res = await historyRequest(apiKey.key, `?month=${period}`);

    expect(res.statusCode).toBe(200);

    const item = res
      .json()
      .history.items.find((entry: { requestId: string }) => entry.requestId === "history-rejected-request");

    expect(item).toBeDefined();
    expect(item.accepted).toBe(false);
    // Same shape as the answer of POST /v1/consume.
    expect(item.rejection).toEqual(consumeRes.json().rejection);
    expect(item.rejection).toMatchObject({ scope: "user", rule: "max_per_request", limit: 20 });
    expect(item).not.toHaveProperty("rejectScope");
    expect(item).not.toHaveProperty("rejectRule");
  });

  it("filters history by externalId", async () => {
    const { apiKey } = await newAccount("history-filter");
    const firstUser = await createUser(apiKey.key, "history-filter-first");
    const secondUser = await createUser(apiKey.key, "history-filter-second");

    const firstConsume = await consume(apiKey.key, firstUser.externalId, "history-filter-request-first", 2);

    const secondConsume = await consume(
      apiKey.key,
      secondUser.externalId,
      "history-filter-request-second",
      3,
    );

    expect(firstConsume.statusCode).toBe(200);
    expect(secondConsume.statusCode).toBe(200);

    const period = firstConsume.json().windowStart.slice(0, 7);

    const res = await historyRequest(
      apiKey.key,
      `?month=${period}&externalId=${encodeURIComponent(firstUser.externalId)}`,
    );

    expect(res.statusCode).toBe(200);

    const items = res.json().history.items;

    expect(items).toHaveLength(1);
    expect(items[0].requestId).toBe("history-filter-request-first");
    expect(items[0].externalId).toBe(firstUser.externalId);
  });

  it("supports limit and offset pagination", async () => {
    const { apiKey } = await newAccount("history-pagination");
    const user = await createUser(apiKey.key, "history-pagination-employee");

    for (let i = 1; i <= 3; i++) {
      const res = await consume(apiKey.key, user.externalId, `history-pagination-${i}`, i);

      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(true);
    }

    const period = new Date().toISOString().slice(0, 7);

    const firstPage = await historyRequest(apiKey.key, `?month=${period}&limit=2&offset=0`);

    const secondPage = await historyRequest(apiKey.key, `?month=${period}&limit=2&offset=2`);

    expect(firstPage.statusCode).toBe(200);
    expect(secondPage.statusCode).toBe(200);

    expect(firstPage.json().history.items).toHaveLength(2);
    expect(secondPage.json().history.items).toHaveLength(1);

    expect(firstPage.json().history.pagination).toMatchObject({
      limit: 2,
      offset: 0,
      returned: 2,
    });

    expect(secondPage.json().history.pagination).toMatchObject({
      limit: 2,
      offset: 2,
      returned: 1,
    });
  });

  it("does not expose another account's history", async () => {
    const firstAccount = await newAccount("history-account-first");
    const secondAccount = await newAccount("history-account-second");

    const firstUser = await createUser(firstAccount.apiKey.key, "history-isolation-employee");

    const consumeRes = await consume(
      firstAccount.apiKey.key,
      firstUser.externalId,
      "history-private-request",
      4,
    );

    expect(consumeRes.statusCode).toBe(200);

    const period = consumeRes.json().windowStart.slice(0, 7);

    const res = await historyRequest(secondAccount.apiKey.key, `?month=${period}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().history.items).toHaveLength(0);
  });
});

describe("GET /v1/usage/history — months and deleted users", () => {
  it("previous months stay queryable: usage per user and request history", async () => {
    const s = await h.scenario({ monthlyLimit: 1000, maxPerRequest: 100 }, { monthlyLimit: 100, maxPerRequest: 50 }, [
      "u1",
      "u2",
    ]);

    h.setNow("2026-05-15T00:00:00Z");
    await h.consume(s.key, "may-1", "u1", 30);
    await h.consume(s.key, "may-2", "u2", 20);
    await h.consume(s.key, "may-3", "u2", 80); // rejected: above the per-request limit

    h.setNow("2026-06-15T00:00:00Z");
    await h.consume(s.key, "jun-1", "u1", 5);

    const may = (await h.call("GET", "/v1/usage/users?month=2026-05", s.key)).body;
    const used = Object.fromEntries(may.users.map((u: { externalId: string; used: number }) => [u.externalId, u.used]));
    expect(used).toEqual({ u1: 30, u2: 20 });

    const mayHistory = (await h.call("GET", "/v1/usage/history?month=2026-05", s.key)).body.history;
    expect(mayHistory.period).toBe("2026-05");
    expect(mayHistory.pagination.total).toBe(3);
    expect(mayHistory.items.filter((i: { accepted: boolean }) => !i.accepted)).toHaveLength(1);

    const juneHistory = (await h.call("GET", "/v1/usage/history", s.key)).body.history; // default = current month
    expect(juneHistory.period).toBe("2026-06");
    expect(juneHistory.pagination.total).toBe(1);
    expect(juneHistory.items[0]).toMatchObject({ requestId: "jun-1", units: 5, windowStart: "2026-06-01" });
  });

  it("keeps the request history of a deleted user", async () => {
    const s = await h.scenario({ monthlyLimit: 1000, maxPerRequest: 100 }, { monthlyLimit: 100, maxPerRequest: 50 });
    await h.consume(s.key, "kept", "u1", 5);
    expect((await h.call("DELETE", `/v1/users/${s.ids.u1}`, s.key)).status).toBe(204);

    const history = (await h.call("GET", "/v1/usage/history", s.key)).body.history;
    expect(history.pagination.total).toBe(1);
    expect(history.items[0]).toMatchObject({ requestId: "kept", externalId: "u1", accepted: true });
  });
});

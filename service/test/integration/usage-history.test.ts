import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../helpers/app.js";

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
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

async function consume(
  key: string,
  externalId: string,
  requestId: string,
  units: number,
) {
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

    const consumeRes = await consume(
      apiKey.key,
      user.externalId,
      "history-accepted-request",
      5,
    );

    expect(consumeRes.statusCode).toBe(200);
    expect(consumeRes.json().accepted).toBe(true);

    const period = consumeRes.json().windowStart.slice(0, 7);

    const res = await historyRequest(
      apiKey.key,
      `?month=${period}`,
    );

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
    });
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
    const consumeRes = await consume(
      apiKey.key,
      user.externalId,
      "history-rejected-request",
      1_000_000,
    );

    expect(consumeRes.statusCode).toBe(200);
    expect(consumeRes.json().accepted).toBe(false);

    const period = consumeRes.json().windowStart.slice(0, 7);

    const res = await historyRequest(
      apiKey.key,
      `?month=${period}`,
    );

    expect(res.statusCode).toBe(200);

    const item = res.json().history.items.find(
      (entry: { requestId: string }) =>
        entry.requestId === "history-rejected-request",
    );

    expect(item).toBeDefined();
    expect(item.accepted).toBe(false);
    expect(item.rejectScope).toBeTruthy();
    expect(item.rejectRule).toBeTruthy();
  });

  it("filters history by externalId", async () => {
    const { apiKey } = await newAccount("history-filter");
    const firstUser = await createUser(apiKey.key, "history-filter-first");
    const secondUser = await createUser(apiKey.key, "history-filter-second");

    const firstConsume = await consume(
      apiKey.key,
      firstUser.externalId,
      "history-filter-request-first",
      2,
    );

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
      const res = await consume(
        apiKey.key,
        user.externalId,
        `history-pagination-${i}`,
        i,
      );

      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(true);
    }

    const period = new Date().toISOString().slice(0, 7);

    const firstPage = await historyRequest(
      apiKey.key,
      `?month=${period}&limit=2&offset=0`,
    );

    const secondPage = await historyRequest(
      apiKey.key,
      `?month=${period}&limit=2&offset=2`,
    );

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

    const firstUser = await createUser(
      firstAccount.apiKey.key,
      "history-isolation-employee",
    );

    const consumeRes = await consume(
      firstAccount.apiKey.key,
      firstUser.externalId,
      "history-private-request",
      4,
    );

    expect(consumeRes.statusCode).toBe(200);

    const period = consumeRes.json().windowStart.slice(0, 7);

    const res = await historyRequest(
      secondAccount.apiKey.key,
      `?month=${period}`,
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().history.items).toHaveLength(0);
  });
});

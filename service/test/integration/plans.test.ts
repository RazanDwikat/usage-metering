
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../helpers/app.js";

let h: TestApp;

beforeAll(async () => {
  h = await createTestApp();
});

afterAll(async () => {
  await h.close();
});

async function newAccount(name = "plans-test") {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: h.admin,
    payload: { name },
  });

  expect(res.statusCode).toBe(201);

  return res.json() as {
    account: { id: string; name: string };
    apiKey: { key: string };
  };
}

function plansRequest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  key?: string,
  payload?: object,
) {
  return h.app.inject({
    method,
    url,
    headers: key === undefined ? {} : { "x-api-key": key },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function createPlan(
  key: string,
  overrides: Partial<{
    name: string;
    scope: "account" | "user";
    monthlyLimit: number;
    maxPerRequest: number;
  }> = {},
) {
  return plansRequest("POST", "/v1/plans", key, {
    name: "Custom plan",
    scope: "user",
    monthlyLimit: 5000,
    maxPerRequest: 100,
    ...overrides,
  });
}

describe("Plans API — authentication", () => {
  it("rejects a missing API key", async () => {
    const res = await plansRequest("GET", "/v1/plans");

    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid API key", async () => {
    const res = await plansRequest("GET", "/v1/plans", "invalid-key");

    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v1/plans", () => {
  it("lists predefined plans and custom plans owned by the account", async () => {
    const { apiKey } = await newAccount("plans-list");
    const created = await createPlan(apiKey.key, {
      name: "My user plan",
    });

    expect(created.statusCode).toBe(201);

    const res = await plansRequest("GET", "/v1/plans", apiKey.key);

    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      plans: Array<{
        id: string;
        name: string;
        scope: string;
        predefined: boolean;
      }>;
    };

    expect(body.plans.some((p) => p.name === "Starter")).toBe(true);
    expect(
      body.plans.some(
        (p) => p.name === "My user plan" && !p.predefined,
      ),
    ).toBe(true);
  });

  it("does not expose another account's custom plans", async () => {
    const first = await newAccount("plans-owner");
    const second = await newAccount("plans-other");

    const created = await createPlan(first.apiKey.key, {
      name: "Private plan",
    });

    expect(created.statusCode).toBe(201);

    const res = await plansRequest(
      "GET",
      "/v1/plans",
      second.apiKey.key,
    );

    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      plans: Array<{ name: string }>;
    };

    expect(body.plans.some((p) => p.name === "Private plan")).toBe(false);
  });
});

describe("POST /v1/plans", () => {
  it("creates a custom plan", async () => {
    const { apiKey } = await newAccount("plans-create");

    const res = await createPlan(apiKey.key, {
      name: "Premium custom",
      scope: "user",
      monthlyLimit: 8000,
      maxPerRequest: 250,
    });

    expect(res.statusCode).toBe(201);

    const body = res.json().plan;

    expect(body).toMatchObject({
      name: "Premium custom",
      scope: "user",
      monthlyLimit: 8000,
      maxPerRequest: 250,
      predefined: false,
    });

    expect(body.id).toBeTruthy();
  });

  it("rejects a plan when maxPerRequest exceeds monthlyLimit", async () => {
    const { apiKey } = await newAccount("plans-invalid-limits");

    const res = await createPlan(apiKey.key, {
      monthlyLimit: 100,
      maxPerRequest: 101,
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown fields", async () => {
    const { apiKey } = await newAccount("plans-unknown-field");

    const res = await plansRequest("POST", "/v1/plans", apiKey.key, {
      name: "Invalid plan",
      scope: "user",
      monthlyLimit: 1000,
      maxPerRequest: 100,
      unexpectedField: true,
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects a duplicate name within the same account and scope", async () => {
    const { apiKey } = await newAccount("plans-duplicate");

    const first = await createPlan(apiKey.key, {
      name: "Duplicate plan",
      scope: "user",
    });

    expect(first.statusCode).toBe(201);

    const second = await createPlan(apiKey.key, {
      name: "Duplicate plan",
      scope: "user",
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("plan_name_already_exists");
  });
});

describe("GET /v1/plans/:id", () => {
  it("returns a plan visible to the authenticated account", async () => {
    const { apiKey } = await newAccount("plans-get");
    const created = await createPlan(apiKey.key, {
      name: "Readable plan",
    });

    const id = created.json().plan.id as string;
    const res = await plansRequest(
      "GET",
      `/v1/plans/${id}`,
      apiKey.key,
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().plan.name).toBe("Readable plan");
  });

  it("does not expose another account's custom plan", async () => {
    const owner = await newAccount("plans-get-owner");
    const other = await newAccount("plans-get-other");

    const created = await createPlan(owner.apiKey.key, {
      name: "Hidden plan",
    });

    const id = created.json().plan.id as string;
    const res = await plansRequest(
      "GET",
      `/v1/plans/${id}`,
      other.apiKey.key,
    );

    expect(res.statusCode).toBe(404);
  });

  it("rejects a malformed plan ID", async () => {
    const { apiKey } = await newAccount("plans-bad-id");

    const res = await plansRequest(
      "GET",
      "/v1/plans/not-a-uuid",
      apiKey.key,
    );

    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /v1/plans/:id", () => {
  it("updates a custom plan", async () => {
    const { apiKey } = await newAccount("plans-update");
    const created = await createPlan(apiKey.key, {
      name: "Before update",
      monthlyLimit: 1000,
      maxPerRequest: 100,
    });

    const id = created.json().plan.id as string;

    const res = await plansRequest(
      "PATCH",
      `/v1/plans/${id}`,
      apiKey.key,
      {
        name: "After update",
        monthlyLimit: 2000,
      },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().plan).toMatchObject({
      id,
      name: "After update",
      monthlyLimit: 2000,
      maxPerRequest: 100,
    });
  });

  it("rejects an update that makes maxPerRequest exceed monthlyLimit", async () => {
    const { apiKey } = await newAccount("plans-update-limits");
    const created = await createPlan(apiKey.key, {
      monthlyLimit: 1000,
      maxPerRequest: 500,
    });

    const id = created.json().plan.id as string;

    // Only the monthly limit changes. The service must compare it
    // against the existing maxPerRequest value as well.
    const res = await plansRequest(
      "PATCH",
      `/v1/plans/${id}`,
      apiKey.key,
      { monthlyLimit: 100 },
    );

    expect(res.statusCode).toBe(400);
  });

  it("applies updated plan limits to subsequent consume requests", async () => {
  const { apiKey } = await newAccount("plans-live-update");

  const createdPlan = await createPlan(apiKey.key, {
    name: "Live update plan",
    scope: "user",
    monthlyLimit: 1000,
    maxPerRequest: 100,
  });

  expect(createdPlan.statusCode).toBe(201);

  const planId = createdPlan.json().plan.id as string;

  const userRes = await h.app.inject({
    method: "POST",
    url: "/v1/users",
    headers: { "x-api-key": apiKey.key },
    payload: {
      externalId: "live-update-employee",
      planId,
    },
  });

  expect(userRes.statusCode).toBe(201);

  const firstConsume = await h.app.inject({
    method: "POST",
    url: "/v1/consume",
    headers: { "x-api-key": apiKey.key },
    payload: {
      requestId: "live-update-before",
      externalId: "live-update-employee",
      units: 50,
    },
  });

  expect(firstConsume.statusCode).toBe(200);
  expect(firstConsume.json().accepted).toBe(true);

  const updateRes = await plansRequest(
    "PATCH",
    `/v1/plans/${planId}`,
    apiKey.key,
    {
      monthlyLimit: 40,
      maxPerRequest: 40,
    },
  );

  expect(updateRes.statusCode).toBe(200);

  const secondConsume = await h.app.inject({
    method: "POST",
    url: "/v1/consume",
    headers: { "x-api-key": apiKey.key },
    payload: {
      requestId: "live-update-after",
      externalId: "live-update-employee",
      units: 1,
    },
  });

  expect(secondConsume.statusCode).toBe(200);
  expect(secondConsume.json().accepted).toBe(false);
  expect(secondConsume.json().rejection).toMatchObject({scope: "user",rule: "monthly_allowance",});
  });

  it("rejects an empty update", async () => {
    const { apiKey } = await newAccount("plans-empty-update");
    const created = await createPlan(apiKey.key);
    const id = created.json().plan.id as string;

    const res = await plansRequest(
      "PATCH",
      `/v1/plans/${id}`,
      apiKey.key,
      {},
    );

    expect(res.statusCode).toBe(400);
  });

  it("does not allow modifying a predefined plan", async () => {
    const { apiKey } = await newAccount("plans-predefined-update");

    const list = await plansRequest("GET", "/v1/plans", apiKey.key);
    const starter = list
      .json()
      .plans.find((p: { name: string; scope: string }) =>
        p.name === "Starter" && p.scope === "account",
      );

    expect(starter).toBeTruthy();

    const res = await plansRequest(
      "PATCH",
      `/v1/plans/${starter.id}`,
      apiKey.key,
      { name: "Changed Starter" },
    );

    expect(res.statusCode).toBe(404);
  });

  it("does not allow modifying another account's plan", async () => {
    const owner = await newAccount("plans-update-owner");
    const other = await newAccount("plans-update-other");

    const created = await createPlan(owner.apiKey.key, {
      name: "Owned plan",
    });

    const id = created.json().plan.id as string;

    const res = await plansRequest(
      "PATCH",
      `/v1/plans/${id}`,
      other.apiKey.key,
      { name: "Hijacked plan" },
    );

    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /v1/plans/:id", () => {
  it("archives an unused custom plan", async () => {
    const { apiKey } = await newAccount("plans-archive");
    const created = await createPlan(apiKey.key, {
      name: "Plan to archive",
    });

    const id = created.json().plan.id as string;

    const res = await plansRequest(
      "DELETE",
      `/v1/plans/${id}`,
      apiKey.key,
    );

    expect(res.statusCode).toBe(204);

    const list = await plansRequest("GET", "/v1/plans", apiKey.key);

    expect(
      list.json().plans.some((p: { id: string }) => p.id === id),
    ).toBe(false);
  });

  it("does not archive a plan assigned to an active user", async () => {
    const { apiKey } = await newAccount("plans-in-use");

    const createdPlan = await createPlan(apiKey.key, {
      name: "Assigned plan",
      scope: "user",
    });

    expect(createdPlan.statusCode).toBe(201);

    const planId = createdPlan.json().plan.id as string;

    const userRes = await h.app.inject({
      method: "POST",
      url: "/v1/users",
      headers: { "x-api-key": apiKey.key },
      payload: {
        externalId: "employee-with-plan",
        planId,
      },
    });

    expect(userRes.statusCode).toBe(201);

    const res = await plansRequest(
      "DELETE",
      `/v1/plans/${planId}`,
      apiKey.key,
    );

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("plan_in_use");
  });
  
  
  it("prevents an active user from being assigned to an archived plan during concurrent requests", async () => {
    const { apiKey } = await newAccount("plans-concurrency");

    const createdPlan = await createPlan(apiKey.key, {
      name: "Concurrent assignment plan",
      scope: "user",
    });

    expect(createdPlan.statusCode).toBe(201);

    const planId = createdPlan.json().plan.id as string;

    // Attempt to assign the plan and archive it at the same time.
    const [userRes, archiveRes] = await Promise.all([
      h.app.inject({
        method: "POST",
        url: "/v1/users",
        headers: { "x-api-key": apiKey.key },
        payload: {
          externalId: "concurrent-employee",
          planId,
        },
      }),

      plansRequest(
        "DELETE",
        `/v1/plans/${planId}`,
        apiKey.key,
      ),
    ]);

    // Both operations must return an expected outcome.
    expect([201, 404]).toContain(userRes.statusCode);
    expect([204, 409]).toContain(archiveRes.statusCode);

    // Read the final plan state after both transactions finish.
    const finalPlanRes = await plansRequest(
      "GET",
      `/v1/plans/${planId}`,
      apiKey.key,
    );

    expect(finalPlanRes.statusCode).toBe(200);

    const finalPlan = finalPlanRes.json().plan;

    if (userRes.statusCode === 201) {
      // If assignment succeeded, archiving must have been rejected.
      expect(archiveRes.statusCode).toBe(409);
      expect(finalPlan.archivedAt).toBeNull();
    }

    if (archiveRes.statusCode === 204) {
      // If archiving succeeded, assignment must have been rejected.
      expect(userRes.statusCode).toBe(404);
      expect(finalPlan.archivedAt).not.toBeNull();
    }
  });

  it("does not allow archiving a predefined plan", async () => {
    const { apiKey } = await newAccount("plans-predefined-archive");

    const list = await plansRequest("GET", "/v1/plans", apiKey.key);
    const starter = list
      .json()
      .plans.find((p: { name: string; scope: string }) =>
        p.name === "Starter" && p.scope === "account",
      );

    expect(starter).toBeTruthy();

    const res = await plansRequest(
      "DELETE",
      `/v1/plans/${starter.id}`,
      apiKey.key,
    );

    expect(res.statusCode).toBe(404);
  });

  it("does not allow archiving another account's plan", async () => {
    const owner = await newAccount("plans-archive-owner");
    const other = await newAccount("plans-archive-other");

    const created = await createPlan(owner.apiKey.key, {
      name: "Other account plan",
    });

    const id = created.json().plan.id as string;

    const res = await plansRequest(
      "DELETE",
      `/v1/plans/${id}`,
      other.apiKey.key,
    );

    expect(res.statusCode).toBe(404);
  });
});

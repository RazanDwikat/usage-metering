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

async function newAccount(name = "users-test") {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: h.admin,
    payload: { name },
  });

  expect(res.statusCode).toBe(201);

  return res.json() as {
    account: {
      id: string;
      name: string;
    };
    apiKey: {
      key: string;
    };
  };
}

function usersRequest(
  method: "GET" | "POST" | "PUT" | "DELETE",
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

async function createUser(key: string, externalId = "employee-001", planId?: string) {
  return usersRequest("POST", "/v1/users", key, {
    externalId,
    ...(planId ? { planId } : {}),
  });
}

async function predefinedPlanId(name: string): Promise<string> {
  const result = await sql<{ id: string }>(
    `SELECT id
     FROM plans
     WHERE name = $1 AND owner_account_id IS NULL`,
    [name],
  );

  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.id;
}

describe("POST /v1/users — authentication", () => {
  it("rejects a missing API key", async () => {
    const res = await usersRequest("POST", "/v1/users", undefined, {
      externalId: "employee-001",
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_api_key");
  });

  it("rejects an invalid API key", async () => {
    const res = await createUser("invalid-key");

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_api_key");
  });
});

describe("POST /v1/users — creation", () => {
  it("creates a user with the default Basic plan", async () => {
    const { apiKey } = await newAccount("create-user");
    const res = await createUser(apiKey.key);

    expect(res.statusCode).toBe(201);

    expect(res.json().user).toMatchObject({
      externalId: "employee-001",
      plan: {
        name: "Basic",
        scope: "user",
        monthlyLimit: 1_000,
        maxPerRequest: 20,
        predefined: true,
      },
    });

    expect(res.json().user.id).toBeTruthy();
    expect(res.json().user.createdAt).toBeTruthy();
  });

  it("trims externalId before creating the user", async () => {
    const { apiKey } = await newAccount("trim-user");
    const res = await createUser(apiKey.key, "  employee-002  ");

    expect(res.statusCode).toBe(201);
    expect(res.json().user.externalId).toBe("employee-002");
  });

  it("rejects duplicate externalIds within the same account", async () => {
    const { apiKey } = await newAccount("duplicate-user");

    expect((await createUser(apiKey.key, "employee-003")).statusCode).toBe(201);

    const duplicate = await createUser(apiKey.key, "employee-003");

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("user_already_exists");
  });

  it.each([
    { name: "missing externalId", payload: {} },
    { name: "empty externalId", payload: { externalId: "   " } },
    {
      name: "externalId too long",
      payload: { externalId: "x".repeat(201) },
    },
    { name: "externalId is not a string", payload: { externalId: 123 } },
    {
      name: "unknown field",
      payload: { externalId: "employee-004", accountId: "some-account" },
    },
    {
      name: "malformed plan ID",
      payload: { externalId: "employee-004", planId: "Basic" },
    },
  ])("returns 400 for invalid input: $name", async ({ payload }) => {
    const { apiKey } = await newAccount("validation-user");
    const res = await usersRequest("POST", "/v1/users", apiKey.key, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("rejects an unknown plan", async () => {
    const { apiKey } = await newAccount("unknown-plan-user");

    const res = await createUser(apiKey.key, "employee-005", "11111111-1111-4111-8111-111111111111");

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("plan_not_found");
  });

  it("rejects an account-scoped plan for a user", async () => {
    const { apiKey } = await newAccount("scope-mismatch-user");
    const starterId = await predefinedPlanId("Starter");

    const res = await createUser(apiKey.key, "employee-006", starterId);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("plan_scope_mismatch");
  });
});

describe("GET /v1/users — listing", () => {
  it("lists only the authenticated account's users", async () => {
    const a = await newAccount("list-a");
    const b = await newAccount("list-b");

    await createUser(a.apiKey.key, "a-employee");
    await createUser(b.apiKey.key, "b-employee");

    const res = await usersRequest("GET", "/v1/users", a.apiKey.key);

    expect(res.statusCode).toBe(200);
    expect(res.json().users).toHaveLength(1);
    expect(res.json().users[0].externalId).toBe("a-employee");
  });

  it("returns an empty list when the account has no users", async () => {
    const { apiKey } = await newAccount("empty-list");

    const res = await usersRequest("GET", "/v1/users", apiKey.key);

    expect(res.statusCode).toBe(200);
    expect(res.json().users).toEqual([]);
  });
});

describe("GET /v1/users/:id — retrieving a user", () => {
  it("returns a user belonging to the authenticated account", async () => {
    const { apiKey } = await newAccount("get-user");
    const created = await createUser(apiKey.key, "employee-007");
    const userId = created.json().user.id;

    const res = await usersRequest("GET", `/v1/users/${userId}`, apiKey.key);

    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({
      id: userId,
      externalId: "employee-007",
      plan: { name: "Basic" },
    });
  });

  it("does not expose another account's user", async () => {
    const a = await newAccount("get-isolation-a");
    const b = await newAccount("get-isolation-b");

    const created = await createUser(b.apiKey.key, "private-employee");
    const userId = created.json().user.id;

    const res = await usersRequest("GET", `/v1/users/${userId}`, a.apiKey.key);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("user_not_found");
  });

  it("returns 400 for a malformed user ID", async () => {
    const { apiKey } = await newAccount("malformed-user-id");

    const res = await usersRequest("GET", "/v1/users/not-a-uuid", apiKey.key);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});

describe("PUT /v1/users/:id/plan — changing plans", () => {
  it("changes a user's plan to Premium", async () => {
    const { apiKey } = await newAccount("change-plan");
    const created = await createUser(apiKey.key, "employee-008");
    const userId = created.json().user.id;
    const premiumId = await predefinedPlanId("Premium");

    const res = await usersRequest("PUT", `/v1/users/${userId}/plan`, apiKey.key, { planId: premiumId });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.plan).toMatchObject({
      id: premiumId,
      name: "Premium",
      scope: "user",
      monthlyLimit: 10_000,
      maxPerRequest: 200,
    });
  });

  it("rejects a plan with the wrong scope", async () => {
    const { apiKey } = await newAccount("change-scope");
    const created = await createUser(apiKey.key, "employee-009");
    const starterId = await predefinedPlanId("Starter");

    const res = await usersRequest("PUT", `/v1/users/${created.json().user.id}/plan`, apiKey.key, {
      planId: starterId,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("plan_scope_mismatch");
  });

  it("does not allow changing another account's user plan", async () => {
    const a = await newAccount("change-isolation-a");
    const b = await newAccount("change-isolation-b");

    const created = await createUser(b.apiKey.key, "private-employee");
    const premiumId = await predefinedPlanId("Premium");

    const res = await usersRequest("PUT", `/v1/users/${created.json().user.id}/plan`, a.apiKey.key, {
      planId: premiumId,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("user_not_found");
  });

  it("rejects a request without planId", async () => {
    const { apiKey } = await newAccount("missing-plan-id");
    const created = await createUser(apiKey.key, "employee-010");

    const res = await usersRequest("PUT", `/v1/users/${created.json().user.id}/plan`, apiKey.key, {});

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});

describe("DELETE /v1/users/:id — soft deletion", () => {
  it("deletes a user without physically removing its database record", async () => {
    const { account, apiKey } = await newAccount("delete-user");
    const created = await createUser(apiKey.key, "employee-011");
    const userId = created.json().user.id;

    const res = await usersRequest("DELETE", `/v1/users/${userId}`, apiKey.key);

    expect(res.statusCode).toBe(204);

    const stored = await sql<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM users WHERE id = $1 AND account_id = $2",
      [userId, account.id],
    );

    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.deleted_at).not.toBeNull();

    const getRes = await usersRequest("GET", `/v1/users/${userId}`, apiKey.key);

    expect(getRes.statusCode).toBe(404);

    const listRes = await usersRequest("GET", "/v1/users", apiKey.key);

    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().users).toEqual([]);
  });

  it("does not allow deleting another account's user", async () => {
    const a = await newAccount("delete-isolation-a");
    const b = await newAccount("delete-isolation-b");

    const created = await createUser(b.apiKey.key, "private-employee");

    const res = await usersRequest("DELETE", `/v1/users/${created.json().user.id}`, a.apiKey.key);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("user_not_found");
  });
});

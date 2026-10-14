import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashApiKey, isWellFormedApiKey } from "../../src/lib/api-key.js";
import { createTestApp, type TestApp } from "../helpers/app.js";

let h: TestApp;
beforeAll(async () => {
  h = await createTestApp((app) => {
    // test-only route to prove unexpected errors never leak details
    app.get("/boom", async () => {
      throw new Error("secret database password is hunter2");
    });
  });
});
afterAll(async () => {
  await h.close();
});

const createAccount = (payload: unknown, headers: Record<string, string> = h.admin) =>
  h.app.inject({ method: "POST", url: "/v1/accounts", headers, payload: payload as object });
const me = (key?: string) =>
  h.app.inject({ method: "GET", url: "/v1/account", headers: key === undefined ? {} : { "x-api-key": key } });
async function newAccount(name = "acme", planId?: string) {
  const res = await createAccount({ name, ...(planId ? { planId } : {}) });
  expect(res.statusCode).toBe(201);
  return res.json() as { account: { id: string; name: string; plan: { id: string; name: string } }; apiKey: { key: string; prefix: string } };
}
const sql = <T extends Record<string, unknown> = Record<string, unknown>>(q: string, p: unknown[] = []) => h.t.pool.query<T>(q, p);

describe("POST /v1/accounts — admin protection", () => {
  it("rejects a missing admin token", async () => {
    const res = await createAccount({ name: "x" }, {});
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_admin_token");
  });

  it("rejects a wrong admin token", async () => {
    expect((await createAccount({ name: "x" }, { "x-admin-token": "nope" })).statusCode).toBe(401);
  });

  it("an account's API key is NOT an admin token", async () => {
    const { apiKey } = await newAccount("not-admin");
    expect((await createAccount({ name: "x" }, { "x-api-key": apiKey.key })).statusCode).toBe(401);
  });

  it("creates nothing when rejected", async () => {
    const before = (await sql("SELECT count(*)::int AS n FROM accounts")).rows[0];
    await createAccount({ name: "ghost" }, {});
    expect((await sql("SELECT count(*)::int AS n FROM accounts")).rows[0]).toEqual(before);
  });
});

describe("POST /v1/accounts — creation", () => {
  it("returns 201 with the account, its default Starter plan, and a well-formed key", async () => {
    const res = await createAccount({ name: "  Acme Inc  " });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const b = res.json();
    expect(b.account.name).toBe("Acme Inc"); // trimmed
    expect(b.account.plan).toMatchObject({ name: "Starter", scope: "account", monthlyLimit: 10_000, maxPerRequest: 100, predefined: true });
    expect(isWellFormedApiKey(b.apiKey.key)).toBe(true);
    expect(b.apiKey.prefix).toBe(b.apiKey.key.slice(0, 8));
  });

  it("can choose another predefined account plan (Pro)", async () => {
    const pro = (await sql<{ id: string }>("SELECT id FROM plans WHERE name='Pro' AND owner_account_id IS NULL")).rows[0]!.id;
    const { account } = await newAccount("pro-co", pro);
    expect(account.plan.name).toBe("Pro");
  });

  it("stores only the HASH of the key, never the key itself", async () => {
    const { account, apiKey } = await newAccount("hash-check");
    const rows = (await sql<{ key_hash: Buffer; prefix: string }>("SELECT key_hash, prefix FROM api_keys WHERE account_id=$1", [account.id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_hash.equals(hashApiKey(apiKey.key))).toBe(true);
    const dump = JSON.stringify((await sql("SELECT * FROM api_keys WHERE account_id=$1", [account.id])).rows);
    expect(dump).not.toContain(apiKey.key);
  });

  it("two accounts get different keys", async () => {
    const a = await newAccount("k1");
    const b = await newAccount("k2");
    expect(a.apiKey.key).not.toBe(b.apiKey.key);
  });
});

describe("POST /v1/accounts — validation and plan rules", () => {
  it.each([
    { name: "missing name", payload: {} },
    { name: "empty name", payload: { name: "   " } },
    { name: "name too long", payload: { name: "x".repeat(201) } },
    { name: "name not a string", payload: { name: 5 } },
    { name: "unknown field", payload: { name: "ok", plan: "Pro" } },
    { name: "planId not a uuid", payload: { name: "ok", planId: "Pro" } },
  ])("400 validation_error: $name", async ({ payload }) => {
    const res = await createAccount(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("400 on malformed JSON", async () => {
    const res = await h.app.inject({ method: "POST", url: "/v1/accounts", headers: { ...h.admin, "content-type": "application/json" }, payload: "{bad" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("404 plan_not_found for an unknown plan", async () => {
    const res = await createAccount({ name: "x", planId: "11111111-1111-4111-8111-111111111111" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("plan_not_found");
  });

  it("400 plan_scope_mismatch for a USER plan", async () => {
    const basic = (await sql<{ id: string }>("SELECT id FROM plans WHERE name='Basic' AND owner_account_id IS NULL")).rows[0]!.id;
    const res = await createAccount({ name: "x", planId: basic });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("plan_scope_mismatch");
  });

  it("another account's CUSTOM plan cannot be used (reported as not found)", async () => {
    const owner = await newAccount("plan-owner");
    const custom = (await sql<{ id: string }>(
      "INSERT INTO plans (scope, owner_account_id, name, monthly_limit, max_per_request) VALUES ('account',$1,'Secret',5,5) RETURNING id",
      [owner.account.id],
    )).rows[0]!.id;
    const res = await createAccount({ name: "thief", planId: custom });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("plan_not_found");
  });

  it("an archived plan cannot be chosen", async () => {
    const pro = (await sql<{ id: string }>("SELECT id FROM plans WHERE name='Pro' AND owner_account_id IS NULL")).rows[0]!.id;
    await sql("UPDATE plans SET archived_at=now() WHERE id=$1", [pro]);
    try {
      expect((await createAccount({ name: "x", planId: pro })).statusCode).toBe(404);
    } finally {
      await sql("UPDATE plans SET archived_at=NULL WHERE id=$1", [pro]);
    }
  });
});

describe("GET /v1/account — API key authentication and isolation", () => {
  it("401 without a key", async () => {
    const res = await me();
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_api_key");
  });

  it.each([
    { name: "garbage", key: "hello" },
    { name: "right shape, unknown key", key: "mk_" + "A".repeat(43) },
    { name: "empty", key: "" },
  ])("401 for an invalid key: $name", async ({ key }) => {
    expect((await me(key)).statusCode).toBe(401);
  });

  it("200 with the caller's own account and plan", async () => {
    const { account, apiKey } = await newAccount("mine");
    const res = await me(apiKey.key);
    expect(res.statusCode).toBe(200);
    expect(res.json().account).toMatchObject({ id: account.id, name: "mine", plan: { name: "Starter" } });
  });

  it("isolation: each key only ever sees its own account", async () => {
    const a = await newAccount("iso-a");
    const b = await newAccount("iso-b");
    expect((await me(a.apiKey.key)).json().account.id).toBe(a.account.id);
    expect((await me(b.apiKey.key)).json().account.id).toBe(b.account.id);
  });

  it("an account id supplied by the caller is ignored (identity comes from the key only)", async () => {
    const a = await newAccount("spoof-a");
    const b = await newAccount("spoof-b");
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/account?accountId=${b.account.id}`,
      headers: { "x-api-key": a.apiKey.key, "x-account-id": b.account.id },
    });
    expect(res.json().account.id).toBe(a.account.id);
  });

  it("a revoked key stops working immediately", async () => {
    const { account, apiKey } = await newAccount("revoke-me");
    expect((await me(apiKey.key)).statusCode).toBe(200);
    await sql("UPDATE api_keys SET revoked_at=now() WHERE account_id=$1", [account.id]);
    expect((await me(apiKey.key)).statusCode).toBe(401);
  });
});

describe("error format", () => {
  it("unknown routes: 404 in the standard shape", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "route_not_found", message: "Route not found" } });
  });

  it("unexpected errors: 500 with a generic message, no leak", async () => {
    const res = await h.app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    expect(res.body).not.toContain("hunter2");
  });
});

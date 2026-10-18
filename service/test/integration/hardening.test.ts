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
  return res.json() as { account: { id: string }; apiKey: { key: string } };
}

const call = (
  key: string | undefined,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
) => h.app.inject({ method, url, headers: key ? { "x-api-key": key } : {}, ...(payload ? { payload } : {}) });

const makeUser = async (key: string, externalId: string, planId?: string) => {
  const res = await call(key, "POST", "/v1/users", { externalId, ...(planId ? { planId } : {}) });
  expect(res.statusCode).toBe(201);
  return res.json().user as { id: string; externalId: string };
};

describe("deleted users", () => {
  it("an externalId can be registered again after the user was deleted (fresh user, fresh usage)", async () => {
    const { apiKey } = await newAccount("reuse");
    const first = await makeUser(apiKey.key, "bob");
    await call(apiKey.key, "POST", "/v1/consume", { requestId: "r1", externalId: "bob", units: 5 });
    expect((await call(apiKey.key, "DELETE", `/v1/users/${first.id}`)).statusCode).toBe(204);

    const second = await makeUser(apiKey.key, "bob");
    expect(second.id).not.toBe(first.id);

    const usage = (await call(apiKey.key, "GET", "/v1/usage?externalId=bob")).json().usage;
    expect(usage.user.used).toBe(0);
    expect(usage.account.used).toBe(5); // the account total still includes the deleted user's usage

    // the deleted user's request stays in the history
    const history = (await call(apiKey.key, "GET", "/v1/usage/history")).json().history;
    expect(history.items.map((i: { requestId: string }) => i.requestId)).toContain("r1");
  });

  it("two concurrent creations of the same externalId: one 201, one 409, never a 500", async () => {
    const { apiKey } = await newAccount("race-create");
    const results = await Promise.all(
      Array.from({ length: 6 }, () => call(apiKey.key, "POST", "/v1/users", { externalId: "same" })),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409, 409]);
  });
});

describe("integer bounds are validation errors, not 500s", () => {
  it("rejects units above the integer range", async () => {
    const { apiKey } = await newAccount("big-units");
    await makeUser(apiKey.key, "u");
    const res = await call(apiKey.key, "POST", "/v1/consume", {
      requestId: "x",
      externalId: "u",
      units: 3_000_000_000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("rejects plan limits above the integer range", async () => {
    const { apiKey } = await newAccount("big-plan");
    const res = await call(apiKey.key, "POST", "/v1/plans", {
      name: "big",
      scope: "user",
      monthlyLimit: 3_000_000_000,
      maxPerRequest: 5,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("plan assignment vs archiving", () => {
  it("assigning a plan to the account and archiving it concurrently never leaves the account on an archived plan", async () => {
    const { apiKey } = await newAccount("assign-vs-archive");
    for (let i = 0; i < 8; i++) {
      const plan = (
        await call(apiKey.key, "POST", "/v1/plans", {
          name: `p${i}`,
          scope: "account",
          monthlyLimit: 50,
          maxPerRequest: 5,
        })
      ).json().plan;
      const [assign, archive] = await Promise.all([
        call(apiKey.key, "PUT", "/v1/account/plan", { planId: plan.id }),
        call(apiKey.key, "DELETE", `/v1/plans/${plan.id}`),
      ]);
      expect(assign.statusCode === 200 && archive.statusCode === 204).toBe(false);
      expect([200, 404]).toContain(assign.statusCode);
      expect([204, 409]).toContain(archive.statusCode);

      const current = (await call(apiKey.key, "GET", "/v1/account")).json().account.plan;
      const stored = (await call(apiKey.key, "GET", `/v1/plans/${current.id}`)).json().plan;
      expect(stored.archivedAt).toBeNull();
    }
  });

  it("editing a plan while consumes are in flight neither deadlocks nor fails", async () => {
    const { apiKey } = await newAccount("edit-while-consuming");
    const plan = (
      await call(apiKey.key, "POST", "/v1/plans", {
        name: "live",
        scope: "user",
        monthlyLimit: 1000,
        maxPerRequest: 10,
      })
    ).json().plan;
    for (const id of ["a", "b", "c", "d"]) await makeUser(apiKey.key, id, plan.id);

    const work: Promise<{ statusCode: number }>[] = [];
    for (let i = 0; i < 40; i++) {
      work.push(
        call(apiKey.key, "POST", "/v1/consume", { requestId: `q${i}`, externalId: "abcd"[i % 4]!, units: 1 }),
      );
      if (i % 8 === 0)
        work.push(call(apiKey.key, "PATCH", `/v1/plans/${plan.id}`, { maxPerRequest: 10 + (i % 3) }));
    }
    const codes = (await Promise.all(work)).map((r) => r.statusCode);
    expect(codes.every((c) => c === 200)).toBe(true);
  });
});

describe("authentication happens before the body is parsed", () => {
  it("a malformed body without a key is 401, not 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/consume",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("deleted users in the usage list", () => {
  it("are listed with a note, last, so the users add up to the account total", async () => {
    const { apiKey } = await newAccount("usage-deleted");
    await makeUser(apiKey.key, "stays");
    const gone = await makeUser(apiKey.key, "gone");
    await makeUser(apiKey.key, "gone-idle");
    await call(apiKey.key, "POST", "/v1/consume", { requestId: "s", externalId: "stays", units: 7 });
    await call(apiKey.key, "POST", "/v1/consume", { requestId: "g", externalId: "gone", units: 5 });
    expect((await call(apiKey.key, "DELETE", `/v1/users/${gone.id}`)).statusCode).toBe(204);
    const idle = (await call(apiKey.key, "GET", "/v1/users")).json().users.find(
      (u: { externalId: string }) => u.externalId === "gone-idle",
    );
    expect((await call(apiKey.key, "DELETE", `/v1/users/${idle.id}`)).statusCode).toBe(204);

    const list = (await call(apiKey.key, "GET", "/v1/usage/users")).json();
    const names = list.users.map((u: { externalId: string }) => u.externalId);
    // the deleted user that used units is listed (after the active one); the deleted user without usage is not
    expect(names).toEqual(["stays", "gone"]);
    expect(list.pagination.total).toBe(2);

    const [active, deleted] = list.users;
    expect(active).toMatchObject({ deleted: false, deletedAt: null, note: null, used: 7 });
    expect(deleted).toMatchObject({ deleted: true, used: 5, remaining: 0 });
    expect(deleted.deletedAt).toEqual(expect.any(String));
    expect(deleted.note).toMatch(/deleted/i);

    const account = (await call(apiKey.key, "GET", "/v1/usage")).json().usage.account;
    expect(list.users.reduce((sum: number, u: { used: number }) => sum + u.used, 0)).toBe(account.used);
  });

  it("a deleted user does not appear in months where it used nothing, and pagination counts it", async () => {
    const { apiKey } = await newAccount("usage-deleted-months");
    const u = await makeUser(apiKey.key, "short-lived");
    await makeUser(apiKey.key, "other");
    await call(apiKey.key, "POST", "/v1/consume", { requestId: "x", externalId: "short-lived", units: 1 });
    await call(apiKey.key, "DELETE", `/v1/users/${u.id}`);

    const past = (await call(apiKey.key, "GET", "/v1/usage/users?month=2020-01")).json();
    expect(past.users.map((x: { externalId: string }) => x.externalId)).toEqual(["other"]);
    expect(past.pagination.total).toBe(1);

    const page1 = (await call(apiKey.key, "GET", "/v1/usage/users?limit=1&offset=0")).json();
    const page2 = (await call(apiKey.key, "GET", "/v1/usage/users?limit=1&offset=1")).json();
    expect(page1.pagination.total).toBe(2);
    expect([page1.users[0].externalId, page2.users[0].externalId]).toEqual(["other", "short-lived"]);
  });
});

describe("POST /v1/accounts/:id/api-keys — operator key recovery", () => {
  const issue = (id: string, headers: Record<string, string> = h.admin) =>
    h.app.inject({ method: "POST", url: `/v1/accounts/${id}/api-keys`, headers });

  it("issues a working key to an account that lost all of its keys", async () => {
    const { account, apiKey } = await newAccount("recover");
    // every key lost: revoked directly, because the API itself refuses to revoke the last active key
    await h.t.pool.query("UPDATE api_keys SET revoked_at = now() WHERE account_id = $1", [account.id]);
    expect((await call(apiKey.key, "GET", "/v1/account")).statusCode).toBe(401);

    const res = await issue(account.id);
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const fresh = res.json().apiKey as { key: string; prefix: string };
    expect(fresh.key).toMatch(/^mk_/);

    const me = await call(fresh.key, "GET", "/v1/account");
    expect(me.statusCode).toBe(200);
    expect(me.json().account.id).toBe(account.id);
  });

  it("needs the admin token: no token, a wrong token, or an account's own API key are all 401", async () => {
    const { account, apiKey } = await newAccount("recover-auth");
    expect((await issue(account.id, {})).statusCode).toBe(401);
    expect((await issue(account.id, { "x-admin-token": "nope" })).statusCode).toBe(401);
    expect((await issue(account.id, { "x-api-key": apiKey.key })).statusCode).toBe(401);
    // nothing was issued
    expect((await call(apiKey.key, "GET", "/v1/account/api-keys")).json().apiKeys).toHaveLength(1);
  });

  it("only touches the account it names: the new key belongs to that account", async () => {
    const a = await newAccount("recover-a");
    const b = await newAccount("recover-b");
    const fresh = (await issue(a.account.id)).json().apiKey.key as string;
    expect((await call(fresh, "GET", "/v1/account")).json().account.id).toBe(a.account.id);
    expect((await call(b.apiKey.key, "GET", "/v1/account/api-keys")).json().apiKeys).toHaveLength(1);
  });

  it("an unknown account is 404 and a malformed id is 400", async () => {
    const unknown = await issue("00000000-0000-4000-8000-000000000000");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("account_not_found");
    expect((await issue("not-a-uuid")).statusCode).toBe(400);
  });
});

describe("API key rotation", () => {
  it("lists keys without secrets", async () => {
    const { apiKey } = await newAccount("keys-list");
    const res = await call(apiKey.key, "GET", "/v1/account/api-keys");
    expect(res.statusCode).toBe(200);
    const keys = res.json().apiKeys;
    expect(keys).toHaveLength(1);
    expect(Object.keys(keys[0]).sort()).toEqual(["createdAt", "id", "prefix", "revokedAt"]);
  });

  it("create a second key, revoke the first: the old key stops working, the new one works", async () => {
    const { apiKey } = await newAccount("keys-rotate");
    const created = await call(apiKey.key, "POST", "/v1/account/api-keys");
    expect(created.statusCode).toBe(201);
    const next = created.json().apiKey as { id: string; key: string };
    expect(next.key).toMatch(/^mk_/);

    const oldId = (await call(next.key, "GET", "/v1/account/api-keys"))
      .json()
      .apiKeys.find((k: { prefix: string }) => k.prefix === apiKey.key.slice(0, 8)).id;
    expect((await call(next.key, "DELETE", `/v1/account/api-keys/${oldId}`)).statusCode).toBe(204);
    expect((await call(apiKey.key, "GET", "/v1/account")).statusCode).toBe(401);
    expect((await call(next.key, "GET", "/v1/account")).statusCode).toBe(200);
    // idempotent
    expect((await call(next.key, "DELETE", `/v1/account/api-keys/${oldId}`)).statusCode).toBe(204);
  });

  it("refuses to revoke the only active key", async () => {
    const { apiKey } = await newAccount("keys-last");
    const id = (await call(apiKey.key, "GET", "/v1/account/api-keys")).json().apiKeys[0].id;
    const res = await call(apiKey.key, "DELETE", `/v1/account/api-keys/${id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("last_active_key");
    expect((await call(apiKey.key, "GET", "/v1/account")).statusCode).toBe(200);
  });

  it("two concurrent revocations cannot remove every key", async () => {
    const { apiKey } = await newAccount("keys-race");
    await call(apiKey.key, "POST", "/v1/account/api-keys");
    const ids = (await call(apiKey.key, "GET", "/v1/account/api-keys"))
      .json()
      .apiKeys.map((k: { id: string }) => k.id);
    const results = await Promise.all(
      ids.map((id: string) => call(apiKey.key, "DELETE", `/v1/account/api-keys/${id}`)),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 409]);
  });

  it("cannot see or revoke another account's keys", async () => {
    const a = await newAccount("keys-iso-a");
    const b = await newAccount("keys-iso-b");
    await call(b.apiKey.key, "POST", "/v1/account/api-keys");
    const bKeyId = (await call(b.apiKey.key, "GET", "/v1/account/api-keys")).json().apiKeys[0].id;
    const res = await call(a.apiKey.key, "DELETE", `/v1/account/api-keys/${bKeyId}`);
    expect(res.statusCode).toBe(404);
    expect((await call(b.apiKey.key, "GET", "/v1/account")).statusCode).toBe(200);
  });

  it("requires authentication", async () => {
    expect((await call(undefined, "POST", "/v1/account/api-keys")).statusCode).toBe(401);
  });
});

describe("pagination and per-user usage", () => {
  it("GET /v1/users is paginated and reports the total", async () => {
    const { apiKey } = await newAccount("users-page");
    for (const id of ["u1", "u2", "u3"]) await makeUser(apiKey.key, id);
    const page1 = (await call(apiKey.key, "GET", "/v1/users?limit=2")).json();
    expect(page1.users).toHaveLength(2);
    expect(page1.pagination).toEqual({ limit: 2, offset: 0, total: 3 });
    const page2 = (await call(apiKey.key, "GET", "/v1/users?limit=2&offset=2")).json();
    expect(page2.users).toHaveLength(1);
    const ids = [...page1.users, ...page2.users].map((u: { id: string }) => u.id);
    expect(new Set(ids).size).toBe(3);
    expect(page1.users[0].plan.name).toBe("Basic");
  });

  it("GET /v1/usage/users shows used/remaining for every user, with their plan", async () => {
    const { apiKey } = await newAccount("usage-users");
    const premium = (await call(apiKey.key, "GET", "/v1/plans"))
      .json()
      .plans.find((p: { name: string }) => p.name === "Premium");
    await makeUser(apiKey.key, "basic-user");
    await makeUser(apiKey.key, "premium-user", premium.id);
    await makeUser(apiKey.key, "idle-user");
    await call(apiKey.key, "POST", "/v1/consume", { requestId: "a", externalId: "basic-user", units: 20 });
    await call(apiKey.key, "POST", "/v1/consume", { requestId: "b", externalId: "premium-user", units: 90 });

    const res = (await call(apiKey.key, "GET", "/v1/usage/users")).json();
    const byId = Object.fromEntries(res.users.map((u: { externalId: string }) => [u.externalId, u]));
    expect(byId["basic-user"]).toMatchObject({
      plan: { name: "Basic" },
      limit: 1000,
      used: 20,
      remaining: 980,
    });
    expect(byId["premium-user"]).toMatchObject({
      plan: { name: "Premium" },
      limit: 10000,
      used: 90,
      remaining: 9910,
    });
    expect(byId["idle-user"]).toMatchObject({ used: 0, remaining: 1000 });
    expect(res.pagination.total).toBe(3);

    const limited = (await call(apiKey.key, "GET", "/v1/usage/users?limit=1")).json();
    expect(limited.users).toHaveLength(1);
    expect(limited.pagination).toMatchObject({ limit: 1, total: 3 });
  });

  it("GET /v1/usage/users: other months are empty, other accounts are invisible, bad month is 400", async () => {
    const a = await newAccount("usage-users-a");
    const b = await newAccount("usage-users-b");
    await makeUser(a.apiKey.key, "mine");
    await makeUser(b.apiKey.key, "theirs");
    await call(a.apiKey.key, "POST", "/v1/consume", { requestId: "m", externalId: "mine", units: 3 });

    const past = (await call(a.apiKey.key, "GET", "/v1/usage/users?month=2020-01")).json();
    expect(past.period).toBe("2020-01");
    expect(past.users[0].used).toBe(0);
    const mine = (await call(a.apiKey.key, "GET", "/v1/usage/users")).json();
    expect(mine.users.map((u: { externalId: string }) => u.externalId)).toEqual(["mine"]);
    expect((await call(a.apiKey.key, "GET", "/v1/usage/users?month=2020-13")).statusCode).toBe(400);
    expect((await call(undefined, "GET", "/v1/usage/users")).statusCode).toBe(401);
  });

  it("history reports the total number of matching requests", async () => {
    const { apiKey } = await newAccount("history-total");
    await makeUser(apiKey.key, "h1");
    for (let i = 0; i < 5; i++) {
      await call(apiKey.key, "POST", "/v1/consume", { requestId: `h${i}`, externalId: "h1", units: 1 });
    }
    const res = (await call(apiKey.key, "GET", "/v1/usage/history?limit=2")).json().history;
    expect(res.items).toHaveLength(2);
    expect(res.pagination).toMatchObject({ limit: 2, offset: 0, returned: 2, total: 5 });
  });
});

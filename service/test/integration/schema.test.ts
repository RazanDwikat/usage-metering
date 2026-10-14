import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import { createTestDb, type TestDb } from "../helpers/db.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const q = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  t.pool.query<T>(sql, p);

/** Runs a statement expected to violate a constraint; returns the pg error code. */
async function failCode(sql: string, p: unknown[] = []): Promise<string> {
  try {
    await q(sql, p);
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "NO_ERROR";
}
const PG = { unique: "23505", fk: "23503", check: "23514", notNull: "23502" };

async function planId(scope: string, name: string) {
  return (await q<{ id: string }>("SELECT id FROM plans WHERE scope=$1 AND name=$2 AND owner_account_id IS NULL", [scope, name])).rows[0]!.id;
}
async function mkAccount(name = "acme") {
  const plan = await planId("account", "Starter");
  return (await q<{ id: string }>("INSERT INTO accounts (name, plan_id) VALUES ($1,$2) RETURNING id", [name, plan])).rows[0]!.id;
}
async function mkUser(accountId: string, ext: string) {
  const plan = await planId("user", "Basic");
  return (await q<{ id: string }>("INSERT INTO users (account_id, external_id, plan_id) VALUES ($1,$2,$3) RETURNING id", [accountId, ext, plan])).rows[0]!.id;
}

describe("migrations + seed", () => {
  it("seeds the four predefined plans with the documented limits", async () => {
    const r = await q("SELECT scope, name, monthly_limit, max_per_request FROM plans WHERE owner_account_id IS NULL ORDER BY name");
    expect(r.rows).toEqual([
      { scope: "user", name: "Basic", monthly_limit: 1000, max_per_request: 20 },
      { scope: "user", name: "Premium", monthly_limit: 10000, max_per_request: 200 },
      { scope: "account", name: "Pro", monthly_limit: 100000, max_per_request: 1000 },
      { scope: "account", name: "Starter", monthly_limit: 10000, max_per_request: 100 },
    ]);
  });

  it("seed is idempotent (re-running adds nothing)", async () => {
    const { seedPredefinedPlans } = await import("../../src/db/seed.js");
    await seedPredefinedPlans(t.pool);
    expect((await q("SELECT count(*)::int AS n FROM plans")).rows[0]).toEqual({ n: 4 });
  });

  it("migration runner is idempotent (nothing to apply the second time)", async () => {
    const { runMigrations } = await import("../../src/db/migrate.js");
    expect(await runMigrations(t.pool)).toEqual([]);
  });
});

describe("drift guard: Drizzle schema.ts vs real database columns", () => {
  for (const table of Object.values(schema).filter((x) => typeof x === "object" && x !== null && "id" in x)) {
    const name = getTableName(table as never);
    it(`${name}`, async () => {
      const dbCols = (await q<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name=$1", [name])).rows
        .map((r) => r.column_name)
        .sort();
      const tsCols = Object.values(getTableColumns(table as never)).map((c) => (c as { name: string }).name).sort();
      expect(tsCols).toEqual(dbCols);
    });
  }
});

describe("constraints the service relies on", () => {
  it("an account-scope plan cannot be assigned to a user", async () => {
    const acc = await mkAccount("a1");
    const pro = await planId("account", "Pro");
    expect(await failCode("INSERT INTO users (account_id, external_id, plan_id) VALUES ($1,'x',$2)", [acc, pro])).toBe(PG.fk);
  });

  it("a user-scope plan cannot be assigned to an account", async () => {
    const basic = await planId("user", "Basic");
    expect(await failCode("INSERT INTO accounts (name, plan_id) VALUES ('bad',$1)", [basic])).toBe(PG.fk);
  });

  it("(account_id, external_id) is unique; same external_id is fine in another account", async () => {
    const a = await mkAccount("a2");
    const b = await mkAccount("a3");
    await mkUser(a, "bob");
    await mkUser(b, "bob");
    expect(await failCode("INSERT INTO users (account_id, external_id, plan_id) VALUES ($1,'bob',$2)", [a, await planId("user", "Basic")])).toBe(PG.unique);
  });

  it("plan limits must be positive", async () => {
    expect(await failCode("INSERT INTO plans (scope, name, monthly_limit, max_per_request, owner_account_id) VALUES ('user','neg',0,5,NULL)")).toBe(PG.check);
    expect(await failCode("INSERT INTO plans (scope, name, monthly_limit, max_per_request, owner_account_id) VALUES ('user','neg2',5,-1,NULL)")).toBe(PG.check);
  });

  it("plan names are unique per account+scope, and among predefined plans", async () => {
    const acc = await mkAccount("a4");
    await q("INSERT INTO plans (scope, owner_account_id, name, monthly_limit, max_per_request) VALUES ('user',$1,'Team',10,5)", [acc]);
    expect(await failCode("INSERT INTO plans (scope, owner_account_id, name, monthly_limit, max_per_request) VALUES ('user',$1,'Team',20,5)", [acc])).toBe(PG.unique);
    expect(await failCode("INSERT INTO plans (scope, owner_account_id, name, monthly_limit, max_per_request) VALUES ('user',NULL,'Basic',20,5)")).toBe(PG.unique);
  });

  it("api key hashes are unique", async () => {
    const acc = await mkAccount("a5");
    await q("INSERT INTO api_keys (account_id, key_hash, prefix) VALUES ($1,'\\x01','k_')", [acc]);
    expect(await failCode("INSERT INTO api_keys (account_id, key_hash, prefix) VALUES ($1,'\\x01','k_')", [acc])).toBe(PG.unique);
  });
});

describe("usage_counters", () => {
  it("account counter (user_id NULL) is unique per month — NULLS NOT DISTINCT", async () => {
    const acc = await mkAccount("c1");
    await q("INSERT INTO usage_counters (account_id, user_id, window_start) VALUES ($1,NULL,'2026-10-01')", [acc]);
    expect(await failCode("INSERT INTO usage_counters (account_id, user_id, window_start) VALUES ($1,NULL,'2026-10-01')", [acc])).toBe(PG.unique);
    // a different month is fine
    await q("INSERT INTO usage_counters (account_id, user_id, window_start) VALUES ($1,NULL,'2026-11-01')", [acc]);
  });

  it("window_start must be the first day of a month", async () => {
    const acc = await mkAccount("c2");
    expect(await failCode("INSERT INTO usage_counters (account_id, user_id, window_start) VALUES ($1,NULL,'2026-10-15')", [acc])).toBe(PG.check);
  });

  it("used can never be negative", async () => {
    const acc = await mkAccount("c3");
    expect(await failCode("INSERT INTO usage_counters (account_id, user_id, window_start, used) VALUES ($1,NULL,'2026-10-01',-1)", [acc])).toBe(PG.check);
  });

  it("a counter cannot point to a user of ANOTHER account (isolation)", async () => {
    const a = await mkAccount("c4");
    const b = await mkAccount("c5");
    const userOfB = await mkUser(b, "eve");
    expect(await failCode("INSERT INTO usage_counters (account_id, user_id, window_start) VALUES ($1,$2,'2026-10-01')", [a, userOfB])).toBe(PG.fk);
  });

  it("used may exceed any limit (a reduced allowance must not break rows)", async () => {
    const acc = await mkAccount("c6");
    await q("INSERT INTO usage_counters (account_id, user_id, window_start, used) VALUES ($1,NULL,'2026-10-01',999999)", [acc]);
  });
});

describe("consume_requests", () => {
  async function insertReq(acc: string, user: string, reqId: string, extra: Record<string, unknown> = {}) {
    const starter = await planId("account", "Starter");
    const basic = await planId("user", "Basic");
    const v = { accepted: true, reject_scope: null, reject_rule: null, units: 10, ...extra };
    return failCode(
      `INSERT INTO consume_requests
        (account_id,user_id,request_id,units,window_start,accepted,reject_scope,reject_rule,
         account_plan_id,user_plan_id,account_monthly_limit,account_max_per_request,
         user_monthly_limit,user_max_per_request,account_remaining,user_remaining)
       VALUES ($1,$2,$3,$4,'2026-10-01',$5,$6,$7,$8,$9,10000,100,1000,20,100,100)`,
      [acc, user, reqId, v.units, v.accepted, v.reject_scope, v.reject_rule, starter, basic],
    );
  }

  it("request_id is unique per account (idempotency) but reusable across accounts", async () => {
    const a = await mkAccount("r1");
    const b = await mkAccount("r2");
    const ua = await mkUser(a, "u");
    const ub = await mkUser(b, "u");
    expect(await insertReq(a, ua, "req-1")).toBe("NO_ERROR");
    expect(await insertReq(a, ua, "req-1")).toBe(PG.unique);
    expect(await insertReq(b, ub, "req-1")).toBe("NO_ERROR");
  });

  it("accepted ⇒ no reject reason; rejected ⇒ scope AND rule required", async () => {
    const a = await mkAccount("r3");
    const u = await mkUser(a, "u");
    expect(await insertReq(a, u, "x1", { accepted: true, reject_scope: "user", reject_rule: "max_per_request" })).toBe(PG.check);
    expect(await insertReq(a, u, "x2", { accepted: false })).toBe(PG.check);
    expect(await insertReq(a, u, "x3", { accepted: false, reject_scope: "user", reject_rule: "max_per_request" })).toBe("NO_ERROR");
  });

  it("units must be positive, and a request cannot reference another account's user", async () => {
    const a = await mkAccount("r4");
    const b = await mkAccount("r5");
    const ua = await mkUser(a, "u");
    const ub = await mkUser(b, "u");
    expect(await insertReq(a, ua, "y1", { units: 0 })).toBe(PG.check);
    expect(await insertReq(a, ub, "y2")).toBe(PG.fk);
  });
});

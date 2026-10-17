import { describe, expect, it } from "vitest";
import { RULES, evaluate } from "../../../src/rules/evaluate.js";
import type { Rule } from "../../../src/rules/types.js";
import { ctx } from "./fixtures.js";

describe("evaluate — the examples from the brief", () => {
  it("25 units: rejected by the USER's per-request limit even though both monthly allowances have room", () => {
    expect(evaluate(ctx({ units: 25 }))).toEqual({
      accepted: false,
      scope: "user",
      rule: "max_per_request",
      limit: 20,
    });
  });

  it("10 units: accepted when both have enough remaining", () => {
    expect(evaluate(ctx({ units: 10 }))).toEqual({ accepted: true });
  });

  it("10 units: rejected by the ACCOUNT's monthly allowance when it has only 5 left, even if the user has plenty", () => {
    expect(evaluate(ctx({ units: 10, usage: { account: 9_995, user: 0 } }))).toEqual({
      accepted: false,
      scope: "account",
      rule: "monthly_allowance",
      limit: 10_000,
    });
  });
});

describe("evaluate — boundaries and plan changes", () => {
  it("accepts a request equal to what is left", () => {
    expect(evaluate(ctx({ units: 10, usage: { user: 990 } })).accepted).toBe(true);
  });

  it("rejects a request one unit above what is left", () => {
    expect(evaluate(ctx({ units: 11, usage: { user: 990 } }))).toMatchObject({
      accepted: false,
      scope: "user",
      rule: "monthly_allowance",
    });
  });

  it("allowance reduced below existing usage: rejects at that level", () => {
    const c = ctx({
      units: 1,
      usage: { user: 800 },
      limits: { user: { monthlyLimit: 500, maxPerRequest: 20 } },
    });
    expect(evaluate(c)).toEqual({ accepted: false, scope: "user", rule: "monthly_allowance", limit: 500 });
  });
});

describe("evaluate — which reason is reported when several rules fail", () => {
  it("user per-request before account per-request", () => {
    // 150 > user 20 and > account 100
    expect(evaluate(ctx({ units: 150 }))).toMatchObject({ scope: "user", rule: "max_per_request" });
  });

  it("account per-request when only the account's limit is exceeded", () => {
    const c = ctx({ units: 150, limits: { user: { monthlyLimit: 1_000, maxPerRequest: 500 } } });
    expect(evaluate(c)).toEqual({ accepted: false, scope: "account", rule: "max_per_request", limit: 100 });
  });

  it("per-request before monthly (same scope)", () => {
    // 25 > user per-request 20, and user only has 10 left
    expect(evaluate(ctx({ units: 25, usage: { user: 990 } }))).toMatchObject({
      scope: "user",
      rule: "max_per_request",
    });
  });

  it("user monthly before account monthly", () => {
    expect(evaluate(ctx({ units: 10, usage: { user: 995, account: 9_995 } }))).toMatchObject({
      scope: "user",
      rule: "monthly_allowance",
    });
  });
});

describe("evaluate — properties", () => {
  it("is pure: does not mutate its input", () => {
    const c = ctx({ units: 25, usage: { user: 5 } });
    const before = structuredClone(c);
    evaluate(c);
    expect(c).toEqual(before);
  });

  it("uses the documented rule order", () => {
    expect(RULES.map((r) => `${r.scope}/${r.name}`)).toEqual([
      "user/max_per_request",
      "account/max_per_request",
      "user/monthly_allowance",
      "account/monthly_allowance",
    ]);
  });

  it("a new rule only needs to be added to the list (extensibility)", () => {
    const rejectAll: Rule = {
      scope: "user",
      name: "monthly_allowance",
      check: () => ({ ok: false, limit: 0 }),
    };
    expect(evaluate(ctx({ units: 1 }), [...RULES, rejectAll])).toMatchObject({ accepted: false, limit: 0 });
  });
});

import { describe, expect, it } from "vitest";
import { monthlyAllowance, remaining } from "../../../src/rules/monthly-allowance.js";
import { ctx } from "./fixtures.js";

describe("remaining", () => {
  it.each([
    { limit: 1000, used: 0, expected: 1000 },
    { limit: 1000, used: 400, expected: 600 },
    { limit: 1000, used: 1000, expected: 0 },
    { limit: 500, used: 800, expected: 0 }, // allowance reduced below usage: 0, never negative
  ])("limit=$limit used=$used -> $expected", ({ limit, used, expected }) => {
    expect(remaining(limit, used)).toBe(expected);
  });
});

describe("monthlyAllowance (user limit 1000)", () => {
  it.each([
    { used: 0, units: 20, ok: true },
    { used: 980, units: 20, ok: true }, // exactly what is left
    { used: 980, units: 21, ok: false }, // one more than what is left
    { used: 1000, units: 1, ok: false }, // nothing left
  ])("used=$used units=$units -> ok=$ok", ({ used, units, ok }) => {
    expect(monthlyAllowance("user").check(ctx({ units, usage: { user: used } })).ok).toBe(ok);
  });

  it("rejects everything once the allowance was reduced below usage", () => {
    const c = ctx({ units: 1, usage: { user: 800 }, limits: { user: { monthlyLimit: 500, maxPerRequest: 20 } } });
    expect(monthlyAllowance("user").check(c)).toEqual({ ok: false, limit: 500 });
  });

  it("checks the account and user counters independently", () => {
    const c = ctx({ units: 10, usage: { account: 9_995, user: 0 } });
    expect(monthlyAllowance("user").check(c).ok).toBe(true);
    expect(monthlyAllowance("account").check(c)).toEqual({ ok: false, limit: 10_000 });
  });
});

import { describe, expect, it } from "vitest";
import { maxPerRequest } from "../../../src/rules/max-per-request.js";
import { ctx } from "./fixtures.js";

describe("maxPerRequest", () => {
  it.each([
    { units: 1, ok: true },
    { units: 19, ok: true },
    { units: 20, ok: true }, // equal to the limit is allowed
    { units: 21, ok: false }, // one over
    { units: 1000, ok: false },
  ])("user limit 20: units=$units -> ok=$ok", ({ units, ok }) => {
    expect(maxPerRequest("user").check(ctx({ units })).ok).toBe(ok);
  });

  it("reports the limit that was exceeded", () => {
    expect(maxPerRequest("user").check(ctx({ units: 25 }))).toEqual({ ok: false, limit: 20 });
    expect(maxPerRequest("account").check(ctx({ units: 101 }))).toEqual({ ok: false, limit: 100 });
  });

  it("does not depend on usage", () => {
    expect(maxPerRequest("user").check(ctx({ units: 20, usage: { user: 999_999 } })).ok).toBe(true);
  });

  it("carries its scope and name", () => {
    const r = maxPerRequest("account");
    expect([r.scope, r.name]).toEqual(["account", "max_per_request"]);
  });
});

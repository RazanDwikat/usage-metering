import type { Rule, Scope } from "./types.js";

export function remaining(limit: number, used: number): number {
  return Math.max(0, limit - used);
}

export const monthlyAllowance = (scope: Scope): Rule => ({
  scope,
  name: "monthly_allowance",
  check: ({ units, limits, usage }) => {
    const limit = limits[scope].monthlyLimit;
    return units <= remaining(limit, usage[scope]) ? { ok: true } : { ok: false, limit };
  },
});

import type { Rule, Scope } from "./types.js";

/** Units still available. Never negative: an allowance reduced below usage shows 0. */
export function remaining(limit: number, used: number): number {
  return Math.max(0, limit - used);
}

/** The whole request must fit in what is left of this month's allowance. */
export const monthlyAllowance = (scope: Scope): Rule => ({
  scope,
  name: "monthly_allowance",
  check: ({ units, limits, usage }) => {
    const limit = limits[scope].monthlyLimit;
    return units <= remaining(limit, usage[scope]) ? { ok: true } : { ok: false, limit };
  },
});

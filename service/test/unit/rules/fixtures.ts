import type { Limits, RuleContext, Usage } from "../../../src/rules/types.js";

// The example from the brief: account 10,000/month + 100/request, user 1,000/month + 20/request.
export const LIMITS: Limits = {
  account: { monthlyLimit: 10_000, maxPerRequest: 100 },
  user: { monthlyLimit: 1_000, maxPerRequest: 20 },
};
export const FRESH: Usage = { account: 0, user: 0 };

export const ctx = (over: {
  units: number;
  usage?: Partial<Usage>;
  limits?: Partial<Limits>;
}): RuleContext => ({
  units: over.units,
  limits: { ...LIMITS, ...over.limits },
  usage: { ...FRESH, ...over.usage },
});

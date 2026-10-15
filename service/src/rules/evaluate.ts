import { maxPerRequest } from "./max-per-request.js";
import { monthlyAllowance } from "./monthly-allowance.js";
import type { Decision, Rule, RuleContext } from "./types.js";

export const RULES: readonly Rule[] = [
  maxPerRequest("user"),
  maxPerRequest("account"),
  monthlyAllowance("user"),
  monthlyAllowance("account"),
];

export function evaluate(ctx: RuleContext, rules: readonly Rule[] = RULES): Decision {
  for (const rule of rules) {
    const result = rule.check(ctx);
    if (!result.ok) {
      return { accepted: false, scope: rule.scope, rule: rule.name, limit: result.limit };
    }
  }
  return { accepted: true };
}

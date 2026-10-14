import { maxPerRequest } from "./max-per-request.js";
import { monthlyAllowance } from "./monthly-allowance.js";
import type { Decision, Rule, RuleContext } from "./types.js";

/**
 * Evaluation order = which reason the caller sees when several rules fail:
 * per-request limits first (they do not depend on usage), user before account
 * (more specific). To add a rule: create a file and add one line here.
 */
export const RULES: readonly Rule[] = [
  maxPerRequest("user"),
  maxPerRequest("account"),
  monthlyAllowance("user"),
  monthlyAllowance("account"),
];

/** Pure: the first failing rule rejects the whole request; otherwise accept it all. */
export function evaluate(ctx: RuleContext, rules: readonly Rule[] = RULES): Decision {
  for (const rule of rules) {
    const result = rule.check(ctx);
    if (!result.ok) {
      return { accepted: false, scope: rule.scope, rule: rule.name, limit: result.limit };
    }
  }
  return { accepted: true };
}

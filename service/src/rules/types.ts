// Pure types for the rule engine. NO database or HTTP imports allowed in src/rules/.

export type Scope = "account" | "user";
export type RuleName = "monthly_allowance" | "max_per_request";

export interface PlanLimits {
  monthlyLimit: number;
  maxPerRequest: number;
}

export interface Limits {
  account: PlanLimits;
  user: PlanLimits;
}

/** Units already consumed this window (before the current request). */
export interface Usage {
  account: number;
  user: number;
}

/**
 * Everything a rule may look at. ASSUMPTION: `units` is already a positive
 * integer — the HTTP layer (zod) validates that before we get here.
 */
export interface RuleContext {
  units: number;
  limits: Limits;
  usage: Usage;
}

export type RuleResult = { ok: true } | { ok: false; limit: number };

/** One rule applied to one scope (account or user). */
export interface Rule {
  scope: Scope;
  name: RuleName;
  check(ctx: RuleContext): RuleResult;
}

export type Decision =
  | { accepted: true }
  | { accepted: false; scope: Scope; rule: RuleName; limit: number };

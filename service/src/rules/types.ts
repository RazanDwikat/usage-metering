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

export interface Usage {
  account: number;
  user: number;
}

export interface RuleContext {
  units: number;
  limits: Limits;
  usage: Usage;
}

export type RuleResult = { ok: true } | { ok: false; limit: number };

export interface Rule {
  scope: Scope;
  name: RuleName;
  check(ctx: RuleContext): RuleResult;
}

export type Decision = { accepted: true } | { accepted: false; scope: Scope; rule: RuleName; limit: number };

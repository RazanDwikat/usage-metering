import type { Db } from "../config/database.js";
import { BadRequestError, NotFoundError } from "../errors/app-error.js";
import { generateApiKey } from "../lib/api-key.js";
import { findAccountWithPlan, insertAccount } from "../repositories/accounts.repo.js";
import { insertApiKey } from "../repositories/api-keys.repo.js";
import { findPlanById, findPredefinedPlan, type PlanRow } from "../repositories/plans.repo.js";

export const DEFAULT_ACCOUNT_PLAN = "Starter";

export interface PlanView {
  id: string;
  name: string;
  scope: "account" | "user";
  monthlyLimit: number;
  maxPerRequest: number;
  predefined: boolean;
}
export interface AccountView {
  id: string;
  name: string;
  createdAt: string;
  plan: PlanView;
}

export const toPlanView = (p: PlanRow): PlanView => ({
  id: p.id,
  name: p.name,
  scope: p.scope,
  monthlyLimit: p.monthlyLimit,
  maxPerRequest: p.maxPerRequest,
  predefined: p.ownerAccountId === null,
});


export async function createAccount(db: Db, input: { name: string; planId?: string }) {
  return db.transaction(async (tx) => {
    const plan = input.planId
      ? await findPlanById(tx, input.planId)
      : await findPredefinedPlan(tx, "account", DEFAULT_ACCOUNT_PLAN);

    if (!input.planId && !plan) {
      throw new Error(`Default plan "${DEFAULT_ACCOUNT_PLAN}" is missing: the seed did not run`);
    }
   
    if (!plan || plan.ownerAccountId !== null || plan.archivedAt !== null) {
      throw new NotFoundError("plan_not_found", "Plan not found");
    }
    if (plan.scope !== "account") {
      throw new BadRequestError("plan_scope_mismatch", "This is a user plan; accounts need an account plan");
    }

    const account = await insertAccount(tx, { name: input.name, planId: plan.id });
    const { key, hash, prefix } = generateApiKey();
    await insertApiKey(tx, { accountId: account.id, keyHash: hash, prefix });

    return {
      account: { id: account.id, name: account.name, createdAt: account.createdAt.toISOString(), plan: toPlanView(plan) },
      apiKey: { key, prefix },
    };
  });
}

export async function getAccount(db: Db, accountId: string): Promise<AccountView> {
  const row = await findAccountWithPlan(db, accountId);
  if (!row) throw new NotFoundError("account_not_found", "Account not found");
  return {
    id: row.account.id,
    name: row.account.name,
    createdAt: row.account.createdAt.toISOString(),
    plan: toPlanView(row.plan),
  };
}

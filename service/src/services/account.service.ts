import type { Db } from "../config/database.js";
import { BadRequestError, NotFoundError } from "../errors/app-error.js";
import { generateApiKey } from "../lib/api-key.js";
import { insertApiKey } from "../repositories/api-keys.repo.js";
import { findAccountWithPlan, insertAccount, updateAccountPlan } from "../repositories/accounts.repo.js";
import { findPlanByIdForShare, findPlanById, findPredefinedPlan } from "../repositories/plans.repo.js";
import { toPlanView, type PlanView } from "../views/plan.js";

export const DEFAULT_ACCOUNT_PLAN = "Starter";

export interface AccountView {
  id: string;
  name: string;
  createdAt: string;
  plan: PlanView;
}

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
      account: {
        id: account.id,
        name: account.name,
        createdAt: account.createdAt.toISOString(),
        plan: toPlanView(plan),
      },
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

export async function changeAccountPlan(db: Db, accountId: string, planId: string): Promise<AccountView> {
  return db.transaction(async (tx) => {
    
    const plan = await findPlanByIdForShare(tx, planId);

    if (
      !plan ||
      plan.archivedAt !== null ||
      (plan.ownerAccountId !== null && plan.ownerAccountId !== accountId)
    ) {
      throw new NotFoundError("plan_not_found", "Plan not found");
    }
    if (plan.scope !== "account") {
      throw new BadRequestError("plan_scope_mismatch", "This is a user plan; accounts need an account plan");
    }

    const updated = await updateAccountPlan(tx, accountId, plan.id);
    if (!updated) throw new NotFoundError("account_not_found", "Account not found");

    return {
      id: updated.id,
      name: updated.name,
      createdAt: updated.createdAt.toISOString(),
      plan: toPlanView(plan),
    };
  });
}

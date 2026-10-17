import { eq } from "drizzle-orm";
import type { Executor } from "../config/database.js";
import { accounts, plans } from "../db/schema.js";

export async function insertAccount(ex: Executor, v: { name: string; planId: string }) {
  const [row] = await ex.insert(accounts).values(v).returning();
  return row!;
}

/** The account together with the plan currently assigned to it. */
export async function findAccountWithPlan(ex: Executor, id: string) {
  const [row] = await ex
    .select({ account: accounts, plan: plans })
    .from(accounts)
    .innerJoin(plans, eq(accounts.planId, plans.id))
    .where(eq(accounts.id, id))
    .limit(1);
  return row ?? null;
}


export async function updateAccountPlan(
  ex: Executor,
  accountId: string,
  planId: string,
) {
  const [row] = await ex
    .update(accounts)
    .set({
      planId,
      planScope: "account",
    })
    .where(eq(accounts.id, accountId))
    .returning();

  return row ?? null;
}

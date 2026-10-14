import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../config/database.js";
import { plans } from "../db/schema.js";

export type PlanRow = typeof plans.$inferSelect;

export async function findPlanById(ex: Executor, id: string): Promise<PlanRow | null> {
  const [row] = await ex.select().from(plans).where(eq(plans.id, id)).limit(1);
  return row ?? null;
}

export async function findPredefinedPlan(ex: Executor, scope: PlanRow["scope"], name: string): Promise<PlanRow | null> {
  const [row] = await ex
    .select()
    .from(plans)
    .where(and(eq(plans.scope, scope), eq(plans.name, name), isNull(plans.ownerAccountId)))
    .limit(1);
  return row ?? null;
}

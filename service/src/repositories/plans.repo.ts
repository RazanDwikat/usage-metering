import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Executor } from "../config/database.js";
import { accounts, plans, users } from "../db/schema.js";

export type PlanRow = typeof plans.$inferSelect;

export async function findPlanById(ex: Executor, id: string): Promise<PlanRow | null> {
  const [row] = await ex.select().from(plans).where(eq(plans.id, id)).limit(1);

  return row ?? null;
}

export async function findPredefinedPlan(
  ex: Executor,
  scope: PlanRow["scope"],
  name: string,
): Promise<PlanRow | null> {
  const [row] = await ex
    .select()
    .from(plans)
    .where(and(eq(plans.scope, scope), eq(plans.name, name), isNull(plans.ownerAccountId)))
    .limit(1);

  return row ?? null;
}

export async function listPlans(ex: Executor, accountId: string): Promise<PlanRow[]> {
  return ex
    .select()
    .from(plans)
    .where(
      and(isNull(plans.archivedAt), or(isNull(plans.ownerAccountId), eq(plans.ownerAccountId, accountId))),
    )
    .orderBy(desc(plans.createdAt));
}

export async function insertPlan(
  ex: Executor,
  input: {
    ownerAccountId: string;
    name: string;
    scope: PlanRow["scope"];
    monthlyLimit: number;
    maxPerRequest: number;
  },
): Promise<PlanRow> {
  const [row] = await ex.insert(plans).values(input).returning();

  if (!row) {
    throw new Error("Failed to create plan");
  }

  return row;
}

export async function updatePlan(
  ex: Executor,
  accountId: string,
  planId: string,
  changes: {
    name?: string;
    monthlyLimit?: number;
    maxPerRequest?: number;
  },
): Promise<PlanRow | null> {
  const [row] = await ex
    .update(plans)
    .set({
      ...changes,
      updatedAt: new Date(),
    })
    .where(and(eq(plans.id, planId), eq(plans.ownerAccountId, accountId), isNull(plans.archivedAt)))
    .returning();

  return row ?? null;
}

export async function archivePlan(ex: Executor, accountId: string, planId: string): Promise<PlanRow | null> {
  const [row] = await ex
    .update(plans)
    .set({
      archivedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(plans.id, planId), eq(plans.ownerAccountId, accountId), isNull(plans.archivedAt)))
    .returning();

  return row ?? null;
}

export async function isPlanAssignedToActiveEntities(ex: Executor, planId: string): Promise<boolean> {
  const [accountRows, userRows] = await Promise.all([
    ex.select({ id: accounts.id }).from(accounts).where(eq(accounts.planId, planId)).limit(1),

    ex
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.planId, planId), isNull(users.deletedAt)))
      .limit(1),
  ]);

  return accountRows.length > 0 || userRows.length > 0;
}

/** Shared lock: blocks plan edits/archiving until we commit, but lets any number of readers (consume, assignments) proceed together. */
export async function findPlanByIdForShare(ex: Executor, id: string): Promise<PlanRow | null> {
  const [row] = await ex.select().from(plans).where(eq(plans.id, id)).limit(1).for("share");
  return row ?? null;
}

/** Share-locks several plans in ONE statement, in id order (so every caller locks them in the same order). */
export async function findPlansByIdsForShare(ex: Executor, ids: string[]): Promise<PlanRow[]> {
  return ex.select().from(plans).where(inArray(plans.id, ids)).orderBy(plans.id).for("share");
}

export async function findPlanByIdForUpdate(ex: Executor, id: string): Promise<PlanRow | null> {
  const [row] = await ex.select().from(plans).where(eq(plans.id, id)).limit(1).for("update");

  return row ?? null;
}
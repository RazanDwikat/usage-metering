import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../config/database.js";
import { plans, usageCounters, users } from "../db/schema.js";

export type UsageCounterRow = typeof usageCounters.$inferSelect;

interface CounterKey {
  accountId: string;
  userId: string | null;
  windowStart: string;
}

export async function getOrCreateCounterForUpdate(tx: Executor, key: CounterKey): Promise<UsageCounterRow> {
  // Create the counter if this is the first usage in the month.
  await tx
    .insert(usageCounters)
    .values({
      accountId: key.accountId,
      userId: key.userId,
      windowType: "month",
      windowStart: key.windowStart,
      used: 0,
    })
    .onConflictDoNothing();

  const userCondition =
    key.userId === null ? isNull(usageCounters.userId) : eq(usageCounters.userId, key.userId);

  const [counter] = await tx
    .select()
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.accountId, key.accountId),
        userCondition,
        eq(usageCounters.windowType, "month"),
        eq(usageCounters.windowStart, key.windowStart),
      ),
    )
    .limit(1)
    .for("update");

  if (!counter) {
    throw new Error("Failed to create or lock usage counter");
  }

  return counter;
}

export async function incrementCounter(
  tx: Executor,
  counterId: number,
  units: number,
): Promise<UsageCounterRow> {
  const [updated] = await tx
    .update(usageCounters)
    .set({
      used: sql`${usageCounters.used} + ${units}`,
      updatedAt: new Date(),
    })
    .where(eq(usageCounters.id, counterId))
    .returning();

  if (!updated) {
    throw new Error("Failed to update usage counter");
  }

  return updated;
}

export async function getUsageCounter(
  ex: Executor,
  accountId: string,
  userId: string | null,
  windowStart: string,
): Promise<UsageCounterRow | null> {
  const userCondition = userId === null ? isNull(usageCounters.userId) : eq(usageCounters.userId, userId);

  const [counter] = await ex
    .select()
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.accountId, accountId),
        userCondition,
        eq(usageCounters.windowType, "month"),
        eq(usageCounters.windowStart, windowStart),
      ),
    )
    .limit(1);

  return counter ?? null;
}

/** One page of active users with their plan and their usage in the given month (0 when they have no counter yet). */
export async function listUsersUsage(
  ex: Executor,
  accountId: string,
  windowStart: string,
  page: { limit: number; offset: number },
) {
  return ex
    .select({
      externalId: users.externalId,
      planId: plans.id,
      planName: plans.name,
      monthlyLimit: plans.monthlyLimit,
      used: sql<number>`coalesce(${usageCounters.used}, 0)`.mapWith(Number),
    })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id))
    .leftJoin(
      usageCounters,
      and(
        eq(usageCounters.accountId, users.accountId),
        eq(usageCounters.userId, users.id),
        eq(usageCounters.windowType, "month"),
        eq(usageCounters.windowStart, windowStart),
      ),
    )
    .where(and(eq(users.accountId, accountId), isNull(users.deletedAt)))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(page.limit)
    .offset(page.offset);
}

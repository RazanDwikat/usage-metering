import { and, count, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../config/database.js";
import { plans, usageCounters, users } from "../db/schema.js";

export type UsageCounterRow = typeof usageCounters.$inferSelect;

interface CounterKey {
  accountId: string;
  userId: string | null;
  windowStart: string;
}

async function selectCounterForUpdate(tx: Executor, key: CounterKey): Promise<UsageCounterRow | null> {
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

  return counter ?? null;
}

/** Locks the counter row (creating it on the first usage of the month) and returns it. */
export async function getOrCreateCounterForUpdate(tx: Executor, key: CounterKey): Promise<UsageCounterRow> {
  // Fast path, one query: the counter exists for every request except the first one of the month.
  const existing = await selectCounterForUpdate(tx, key);
  if (existing) return existing;

  // First usage this month. Concurrent first requests race here: the unique index lets exactly one insert win and the
  // others do nothing (they wait for the winner to commit); then every one of them locks the same row.
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

  const created = await selectCounterForUpdate(tx, key);
  if (!created) {
    throw new Error("Failed to create or lock usage counter");
  }

  return created;
}

/** Adds `units` to several counters in ONE statement (the caller already holds their row locks). */
export async function incrementCounters(tx: Executor, counterIds: number[], units: number): Promise<void> {
  const updated = await tx
    .update(usageCounters)
    .set({
      used: sql`${usageCounters.used} + ${units}`,
      updatedAt: new Date(),
    })
    .where(inArray(usageCounters.id, counterIds))
    .returning({ id: usageCounters.id });

  if (updated.length !== counterIds.length) {
    throw new Error("Failed to update usage counter");
  }
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

/**
 * Which users appear in a month's usage list: every active user, plus deleted users that used units in that month
 * (their usage is still part of the account total, so leaving them out would make the numbers not add up).
 */
function usageListUsers(accountId: string, windowStart: string) {
  const counterJoin = and(
    eq(usageCounters.accountId, users.accountId),
    eq(usageCounters.userId, users.id),
    eq(usageCounters.windowType, "month"),
    eq(usageCounters.windowStart, windowStart),
  );
  const where = and(
    eq(users.accountId, accountId),
    or(isNull(users.deletedAt), isNotNull(usageCounters.id)),
  );
  return { counterJoin, where };
}

/** One page of users with their plan and their usage in the given month (0 when they have no counter yet). Deleted users come last. */
export async function listUsersUsage(
  ex: Executor,
  accountId: string,
  windowStart: string,
  page: { limit: number; offset: number },
) {
  const { counterJoin, where } = usageListUsers(accountId, windowStart);
  return ex
    .select({
      externalId: users.externalId,
      deletedAt: users.deletedAt,
      planId: plans.id,
      planName: plans.name,
      monthlyLimit: plans.monthlyLimit,
      used: sql<number>`coalesce(${usageCounters.used}, 0)`.mapWith(Number),
    })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id))
    .leftJoin(usageCounters, counterJoin)
    .where(where)
    .orderBy(sql`(${users.deletedAt} IS NOT NULL)`, desc(users.createdAt), desc(users.id))
    .limit(page.limit)
    .offset(page.offset);
}

/** How many users {@link listUsersUsage} lists for that month (the pagination total). */
export async function countUsersUsage(ex: Executor, accountId: string, windowStart: string): Promise<number> {
  const { counterJoin, where } = usageListUsers(accountId, windowStart);
  const [row] = await ex.select({ n: count() }).from(users).leftJoin(usageCounters, counterJoin).where(where);
  return row?.n ?? 0;
}

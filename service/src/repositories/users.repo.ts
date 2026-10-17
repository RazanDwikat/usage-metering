import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { Executor } from "../config/database.js";
import { plans, users } from "../db/schema.js";

export type UserRow = typeof users.$inferSelect;

export async function insertUser(
  ex: Executor,
  values: {
    accountId: string;
    externalId: string;
    planId: string;
  },
): Promise<UserRow> {
  const [row] = await ex
    .insert(users)
    .values({
      ...values,
      planScope: "user",
    })
    .returning();

  return row!;
}

export async function findUserById(ex: Executor, accountId: string, userId: string): Promise<UserRow | null> {
  const [row] = await ex
    .select()
    .from(users)
    .where(and(eq(users.accountId, accountId), eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  return row ?? null;
}

/** One page of active users with their plans (a single query, no per-user lookups). */
export async function listUsersWithPlans(
  ex: Executor,
  accountId: string,
  page: { limit: number; offset: number },
) {
  return ex
    .select({ user: users, plan: plans })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id))
    .where(and(eq(users.accountId, accountId), isNull(users.deletedAt)))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(page.limit)
    .offset(page.offset);
}

export async function countActiveUsers(ex: Executor, accountId: string): Promise<number> {
  const [row] = await ex
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.accountId, accountId), isNull(users.deletedAt)));
  return row?.n ?? 0;
}

export async function updateUserPlan(
  ex: Executor,
  accountId: string,
  userId: string,
  planId: string,
): Promise<UserRow | null> {
  const [row] = await ex
    .update(users)
    .set({ planId })
    .where(and(eq(users.accountId, accountId), eq(users.id, userId), isNull(users.deletedAt)))
    .returning();

  return row ?? null;
}

export async function findUserByExternalId(
  ex: Executor,
  accountId: string,
  externalId: string,
): Promise<UserRow | null> {
  const [row] = await ex
    .select()
    .from(users)
    .where(and(eq(users.accountId, accountId), eq(users.externalId, externalId), isNull(users.deletedAt)))
    .limit(1);

  return row ?? null;
}

export async function softDeleteUser(
  ex: Executor,
  accountId: string,
  userId: string,
): Promise<UserRow | null> {
  const [row] = await ex
    .update(users)
    .set({ deletedAt: new Date() })
    .where(and(eq(users.accountId, accountId), eq(users.id, userId), isNull(users.deletedAt)))
    .returning();

  return row ?? null;
}

export async function findUserByExternalIdForUpdate(
  tx: Executor,
  accountId: string,
  externalId: string,
): Promise<UserRow | null> {
  const [row] = await tx
    .select()
    .from(users)
    .where(and(eq(users.accountId, accountId), eq(users.externalId, externalId), isNull(users.deletedAt)))
    .limit(1)
    .for("update");

  return row ?? null;
}

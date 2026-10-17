import { and, count, desc, eq, gte, lt } from "drizzle-orm";
import type { Executor } from "../config/database.js";
import { consumeRequests, users } from "../db/schema.js";

export type ConsumeRequestRow = typeof consumeRequests.$inferSelect;

export async function findConsumeRequest(
  ex: Executor,
  accountId: string,
  requestId: string,
): Promise<ConsumeRequestRow | null> {
  const [row] = await ex
    .select()
    .from(consumeRequests)
    .where(and(eq(consumeRequests.accountId, accountId), eq(consumeRequests.requestId, requestId)))
    .limit(1);

  return row ?? null;
}

export async function insertConsumeRequest(
  ex: Executor,
  input: typeof consumeRequests.$inferInsert,
): Promise<ConsumeRequestRow> {
  const [row] = await ex.insert(consumeRequests).values(input).returning();

  if (!row) {
    throw new Error("Failed to record consume request");
  }

  return row;
}

interface ConsumeHistoryFilters {
  accountId: string;
  windowStart: string;
  externalId?: string;
  limit: number;
  offset: number;
}

function historyWhere(f: Pick<ConsumeHistoryFilters, "accountId" | "windowStart" | "externalId">) {
  return and(
    eq(consumeRequests.accountId, f.accountId),
    gte(consumeRequests.windowStart, f.windowStart),
    lt(consumeRequests.windowStart, nextMonthStart(f.windowStart)),
    ...(f.externalId !== undefined ? [eq(users.externalId, f.externalId)] : []),
  );
}

const joinUsers = and(
  // (account_id, id) pair: a request can only ever join a user of its own account.
  eq(users.id, consumeRequests.userId),
  eq(users.accountId, consumeRequests.accountId),
);

export async function listConsumeHistory(ex: Executor, filters: ConsumeHistoryFilters) {
  return ex
    .select({
      requestId: consumeRequests.requestId,
      externalId: users.externalId,
      units: consumeRequests.units,
      windowStart: consumeRequests.windowStart,
      accepted: consumeRequests.accepted,
      rejectScope: consumeRequests.rejectScope,
      rejectRule: consumeRequests.rejectRule,
      accountMonthlyLimit: consumeRequests.accountMonthlyLimit,
      accountMaxPerRequest: consumeRequests.accountMaxPerRequest,
      userMonthlyLimit: consumeRequests.userMonthlyLimit,
      userMaxPerRequest: consumeRequests.userMaxPerRequest,
      accountRemaining: consumeRequests.accountRemaining,
      userRemaining: consumeRequests.userRemaining,
      createdAt: consumeRequests.createdAt,
    })
    .from(consumeRequests)
    .innerJoin(users, joinUsers)
    .where(historyWhere(filters))
    .orderBy(desc(consumeRequests.createdAt), desc(consumeRequests.id))
    .limit(filters.limit)
    .offset(filters.offset);
}

export async function countConsumeHistory(
  ex: Executor,
  filters: Pick<ConsumeHistoryFilters, "accountId" | "windowStart" | "externalId">,
): Promise<number> {
  const [row] = await ex
    .select({ n: count() })
    .from(consumeRequests)
    .innerJoin(users, joinUsers)
    .where(historyWhere(filters));
  return row?.n ?? 0;
}

function nextMonthStart(windowStart: string): string {
  const [year, month] = windowStart.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month!, 1));
  return date.toISOString().slice(0, 10);
}

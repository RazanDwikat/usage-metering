import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { Executor } from "../config/database.js";
import { apiKeys } from "../db/schema.js";

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export async function insertApiKey(
  ex: Executor,
  v: { accountId: string; keyHash: Buffer; prefix: string },
): Promise<ApiKeyRow> {
  const [row] = await ex.insert(apiKeys).values(v).returning();
  return row!;
}

/** Returns the owning account, or null if the key is unknown or revoked. */
export async function findAccountIdByKeyHash(ex: Executor, keyHash: Buffer): Promise<string | null> {
  const [row] = await ex
    .select({ accountId: apiKeys.accountId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);
  return row?.accountId ?? null;
}

export async function listApiKeys(ex: Executor, accountId: string): Promise<ApiKeyRow[]> {
  return ex.select().from(apiKeys).where(eq(apiKeys.accountId, accountId)).orderBy(asc(apiKeys.createdAt));
}

export async function findApiKey(ex: Executor, accountId: string, keyId: string): Promise<ApiKeyRow | null> {
  const [row] = await ex
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.accountId, accountId), eq(apiKeys.id, keyId)))
    .limit(1);
  return row ?? null;
}

export async function countActiveApiKeys(ex: Executor, accountId: string): Promise<number> {
  const [row] = await ex
    .select({ n: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.accountId, accountId), isNull(apiKeys.revokedAt)));
  return row?.n ?? 0;
}

export async function revokeApiKey(ex: Executor, accountId: string, keyId: string): Promise<void> {
  await ex
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.accountId, accountId), eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)));
}

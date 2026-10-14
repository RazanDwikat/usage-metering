import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../config/database.js";
import { apiKeys } from "../db/schema.js";

export async function insertApiKey(ex: Executor, v: { accountId: string; keyHash: Buffer; prefix: string }) {
  await ex.insert(apiKeys).values(v);
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

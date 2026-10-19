import type { Db } from "../config/database.js";
import { ConflictError, NotFoundError } from "../errors/app-error.js";
import { generateApiKey } from "../lib/api-key.js";
import { findAccountWithPlan, lockAccount } from "../repositories/accounts.repo.js";
import {
  countActiveApiKeys,
  findApiKey,
  insertApiKey,
  listApiKeys,
  revokeApiKey as revokeApiKeyRow,
  type ApiKeyRow,
} from "../repositories/api-keys.repo.js";

export interface ApiKeyView {
  id: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

const toView = (k: ApiKeyRow): ApiKeyView => ({
  id: k.id,
  prefix: k.prefix,
  createdAt: k.createdAt.toISOString(),
  revokedAt: k.revokedAt?.toISOString() ?? null,
});

export async function getApiKeys(db: Db, accountId: string): Promise<ApiKeyView[]> {
  return (await listApiKeys(db, accountId)).map(toView);
}


export async function createApiKey(db: Db, accountId: string) {
  const { key, hash, prefix } = generateApiKey();
  const row = await insertApiKey(db, { accountId, keyHash: hash, prefix });
  return { ...toView(row), key }; // the secret is shown only now
}

export async function issueApiKeyForAccount(db: Db, accountId: string) {
  if (!(await findAccountWithPlan(db, accountId))) {
    throw new NotFoundError("account_not_found", "Account not found");
  }
  return createApiKey(db, accountId);
}


export async function revokeApiKey(db: Db, accountId: string, keyId: string): Promise<void> {
  await db.transaction(async (tx) => {
    
    await lockAccount(tx, accountId);

    const key = await findApiKey(tx, accountId, keyId);
    if (!key) throw new NotFoundError("api_key_not_found", "API key not found");
    if (key.revokedAt !== null) return;

    if ((await countActiveApiKeys(tx, accountId)) <= 1) {
      throw new ConflictError(
        "last_active_key",
        "Cannot revoke the account's only active API key; create another first",
      );
    }
    await revokeApiKeyRow(tx, accountId, keyId);
  });
}

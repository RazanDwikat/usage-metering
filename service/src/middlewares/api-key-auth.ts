import type { FastifyRequest } from "fastify";
import type { Db } from "../config/database.js";
import { UnauthorizedError } from "../errors/app-error.js";
import { hashApiKey, isWellFormedApiKey } from "../lib/api-key.js";
import { findAccountIdByKeyHash } from "../repositories/api-keys.repo.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireApiKey: the account the key belongs to. NEVER read an account id from the body/URL. */
    accountId: string;
  }
}

/** Identifies the calling account from the X-API-Key header. Every account-scoped route uses this. */
export function requireApiKey(db: Db) {
  return async (req: FastifyRequest): Promise<void> => {
    const key = req.headers["x-api-key"];
    if (typeof key !== "string" || !isWellFormedApiKey(key)) {
      throw new UnauthorizedError("invalid_api_key", "Missing or invalid X-API-Key");
    }
    const accountId = await findAccountIdByKeyHash(db, hashApiKey(key));
    if (!accountId) throw new UnauthorizedError("invalid_api_key", "Missing or invalid X-API-Key");
    req.accountId = accountId;
  };
}

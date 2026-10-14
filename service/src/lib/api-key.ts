import { createHash, randomBytes } from "node:crypto";

export const KEY_PREFIX = "mk_";
const RANDOM_BYTES = 32; // 256 bits of randomness -> 43 base64url chars
const KEY_LENGTH = KEY_PREFIX.length + 43;
const SHAPE = /^mk_[A-Za-z0-9_-]{43}$/;

export interface GeneratedApiKey {
  /** The full secret. Shown to the caller ONCE; never stored. */
  key: string;
  /** SHA-256 of the key: this is what we store (api_keys.key_hash). */
  hash: Buffer;
  /** First 8 chars, safe to display so people can tell keys apart (api_keys.prefix). */
  prefix: string;
}

export function hashApiKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export function generateApiKey(): GeneratedApiKey {
  const key = KEY_PREFIX + randomBytes(RANDOM_BYTES).toString("base64url");
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 8) };
}

/** Cheap shape check so garbage headers are rejected before we hash or touch the database. */
export function isWellFormedApiKey(value: string): boolean {
  return value.length === KEY_LENGTH && SHAPE.test(value);
}

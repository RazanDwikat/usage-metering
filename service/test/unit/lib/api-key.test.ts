import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, isWellFormedApiKey } from "../../../src/lib/api-key.js";

describe("generateApiKey", () => {
  it("has the mk_ prefix and a well-formed shape", () => {
    const { key } = generateApiKey();
    expect(key.startsWith("mk_")).toBe(true);
    expect(isWellFormedApiKey(key)).toBe(true);
  });

  it("is random: 1000 keys are all different", () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateApiKey().key));
    expect(keys.size).toBe(1000);
  });

  it("returns the SHA-256 of the key, and the hash is not the key", () => {
    const { key, hash } = generateApiKey();
    expect(hash).toEqual(createHash("sha256").update(key).digest());
    expect(hash.length).toBe(32);
    expect(hash.toString("utf8")).not.toContain(key);
  });

  it("prefix is the first 8 chars of the key (safe to display)", () => {
    const { key, prefix } = generateApiKey();
    expect(prefix).toBe(key.slice(0, 8));
    expect(prefix.length).toBe(8);
  });
});

describe("hashApiKey", () => {
  it("is deterministic", () => {
    expect(hashApiKey("mk_abc")).toEqual(hashApiKey("mk_abc"));
  });

  it("different keys give different hashes", () => {
    expect(hashApiKey("mk_abc")).not.toEqual(hashApiKey("mk_abd"));
  });
});

describe("isWellFormedApiKey", () => {
  const good = generateApiKey().key;

  it.each([
    { name: "empty", value: "" },
    { name: "no prefix", value: good.slice(3) },
    { name: "wrong prefix", value: "xx_" + good.slice(3) },
    { name: "too short", value: good.slice(0, -1) },
    { name: "too long", value: good + "a" },
    { name: "bad characters", value: "mk_" + "!".repeat(43) },
    { name: "huge garbage", value: "mk_" + "a".repeat(100_000) },
  ])("rejects: $name", ({ value }) => {
    expect(isWellFormedApiKey(value)).toBe(false);
  });

  it("accepts a generated key", () => {
    expect(isWellFormedApiKey(good)).toBe(true);
  });
});

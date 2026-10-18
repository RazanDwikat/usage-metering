import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";

describe("loadConfig", () => {
  const base = { DATABASE_URL: "postgres://x", ADMIN_TOKEN: "12345678" };

  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(3000);
    expect(c.DB_POOL_MAX).toBe(20);
    expect(c.WEB_CONCURRENCY).toBe(1); // a single process unless asked otherwise
  });

  it("coerces numeric env vars", () => {
    expect(loadConfig({ ...base, PORT: "4000" }).PORT).toBe(4000);
    expect(loadConfig({ ...base, WEB_CONCURRENCY: "4" }).WEB_CONCURRENCY).toBe(4);
  });

  it("rejects a WEB_CONCURRENCY below 1 or above 32", () => {
    expect(() => loadConfig({ ...base, WEB_CONCURRENCY: "0" })).toThrow(/WEB_CONCURRENCY/);
    expect(() => loadConfig({ ...base, WEB_CONCURRENCY: "33" })).toThrow(/WEB_CONCURRENCY/);
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => loadConfig({ ADMIN_TOKEN: "12345678" })).toThrow(/DATABASE_URL/);
  });

  it("rejects a short ADMIN_TOKEN", () => {
    expect(() => loadConfig({ ...base, ADMIN_TOKEN: "short" })).toThrow(/ADMIN_TOKEN/);
  });
});
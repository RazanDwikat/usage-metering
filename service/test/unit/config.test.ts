import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";

describe("loadConfig", () => {
  const base = { DATABASE_URL: "postgres://x", ADMIN_TOKEN: "12345678" };

  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(3000);
    expect(c.DB_POOL_MAX).toBe(20);
  });

  it("coerces numeric env vars", () => {
    expect(loadConfig({ ...base, PORT: "4000" }).PORT).toBe(4000);
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => loadConfig({ ADMIN_TOKEN: "12345678" })).toThrow(/DATABASE_URL/);
  });

  it("rejects a short ADMIN_TOKEN", () => {
    expect(() => loadConfig({ ...base, ADMIN_TOKEN: "short" })).toThrow(/ADMIN_TOKEN/);
  });
});

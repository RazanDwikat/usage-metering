import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Db, Pool } from "../../src/config/database.js";

describe("GET /health", () => {
  it("returns ok when the database answers", async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
    const app = buildApp({
      db: {} as Db,
      config: { DATABASE_URL: "x", ADMIN_TOKEN: "12345678", PORT: 3000, DB_POOL_MAX: 1, WEB_CONCURRENCY: 1 },
      pool,
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
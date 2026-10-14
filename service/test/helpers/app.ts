import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { Config } from "../../src/config/env.js";
import { createTestDb, type TestDb } from "./db.js";

export const ADMIN_TOKEN = "test-admin-token";

export interface TestApp {
  app: FastifyInstance;
  t: TestDb;
  admin: { "x-admin-token": string };
  close: () => Promise<void>;
}

/** A real app on a brand-new migrated + seeded database. `setup` runs before the app is started (add test-only routes there). */
export async function createTestApp(setup?: (app: FastifyInstance) => void): Promise<TestApp> {
  const t = await createTestDb();
  const config: Config = { DATABASE_URL: "unused", ADMIN_TOKEN, PORT: 3000, DB_POOL_MAX: 5 };
  const app = buildApp({ config, pool: t.pool, db: t.db });
  setup?.(app);
  await app.ready();
  return {
    app,
    t,
    admin: { "x-admin-token": ADMIN_TOKEN },
    close: async () => {
      await app.close();
      await t.drop();
    },
  };
}

import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, createPool, type Db, type Pool } from "../../src/config/database.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";

const BASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://metering:metering@localhost:5433/metering";

export interface TestDb {
  pool: Pool;
  db: Db;
  name: string;
  drop: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `metering_test_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), 5);
  await runMigrations(pool);
  await seedPredefinedPlans(pool);

  return {
    pool,
    db: createDb(pool),
    name,
    drop: async () => {
      await pool.end();
      const a = new pg.Client({ connectionString: BASE_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
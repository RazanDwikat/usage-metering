import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "../config/database.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/db -> ../../drizzle (works for tsx and for dist/db)
const MIGRATIONS_DIR = path.resolve(here, "../../drizzle");

/**
 * Tiny forward-only migration runner: applies drizzle/*.sql in filename
 * order, each in its own transaction, tracked in schema_migrations.
 * An advisory lock makes concurrent startups safe.
 */
export async function runMigrations(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    client.release();
  }
  return applied;
}

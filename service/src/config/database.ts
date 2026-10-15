import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";

export type Pool = pg.Pool;
export type Db = NodePgDatabase<typeof schema>;

export function createPool(databaseUrl: string, max: number): Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max, connectionTimeoutMillis: 5_000 });
  pool.on("error", (err) => {
    // an idle client erroring must not crash the process silently
    console.error("Unexpected idle pg client error", err);
  });
  return pool;
}

/** Typed query builder over the SAME pool (so transactions share its connections). */
export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

/** An open transaction. Repositories accept either `Db` or `Tx`, so a service can group several of them atomically. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

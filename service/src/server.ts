import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { createDb, createPool } from "./config/database.js";
import { runMigrations } from "./db/migrate.js";
import { seedPredefinedPlans } from "./db/seed.js";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);

  const applied = await runMigrations(pool);
  if (applied.length) console.log("Applied migrations:", applied.join(", "));
  await seedPredefinedPlans(pool);

  const app = buildApp({ config, pool, db: createDb(pool) });
  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  const shutdown = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

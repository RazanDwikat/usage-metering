import cluster from "node:cluster";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config/env.js";
import { createDb, createPool } from "./config/database.js";
import { runMigrations } from "./db/migrate.js";
import { seedPredefinedPlans } from "./db/seed.js";

/** Migrations + predefined plans. Runs exactly once per start (never in every worker). */
async function prepareDatabase(config: Config) {
  const pool = createPool(config.DATABASE_URL, 2);
  try {
    const applied = await runMigrations(pool);
    if (applied.length) console.log("Applied migrations:", applied.join(", "));
    await seedPredefinedPlans(pool);
  } finally {
    await pool.end();
  }
}

/** One HTTP server process (the whole service when WEB_CONCURRENCY=1, otherwise one cluster worker). */
async function serve(config: Config) {
  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);
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

/** Primary process of a cluster: prepares the database once, forks the workers and keeps them alive. */
async function supervise(config: Config) {
  await prepareDatabase(config);

  let alive = 0;
  let stopping = false;
  const fork = () => {
    alive++;
    cluster.fork();
  };

  cluster.on("exit", (worker, code, signal) => {
    alive--;
    if (stopping) {
      if (alive === 0) process.exit(0);
      return;
    }
    console.error(`Worker ${worker.process.pid} exited (code ${code}, signal ${signal}); starting a new one`);
    fork();
  });

  const stop = () => {
    stopping = true;
    if (alive === 0) process.exit(0);
    for (const worker of Object.values(cluster.workers ?? {})) worker?.process.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  for (let i = 0; i < config.WEB_CONCURRENCY; i++) fork();
  console.log(`Started ${config.WEB_CONCURRENCY} workers`);
}

async function main() {
  const config = loadConfig();

  if (config.WEB_CONCURRENCY > 1 && cluster.isPrimary) {
    await supervise(config);
    return;
  }
  if (cluster.isPrimary) await prepareDatabase(config); // single process: it does everything itself
  await serve(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
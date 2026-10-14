import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config/env.js";
import type { Db, Pool } from "./config/database.js";
import { registerErrorHandling } from "./middlewares/error-handler.js";
import { accountRoutes } from "./routes/accounts.js";

export interface AppDeps {
  config: Config;
  pool: Pool;
  db: Db; // typed query builder (same pool), used by the routes/services
}

/**
 * Builds the Fastify app WITHOUT listening, so tests can use app.inject().
 * Add new route modules to the /v1 section below.
 */
export function buildApp({ config, pool, db }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  app.decorateRequest("accountId", "");
  registerErrorHandling(app);

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });

  app.register(accountRoutes({ db, config }), { prefix: "/v1" });

  return app;
}

import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config/env.js";
import type { Db, Pool } from "./config/database.js";
import { systemClock, type Clock } from "./lib/time.js";
import { registerErrorHandling } from "./middlewares/error-handler.js";
import { accountRoutes } from "./routes/accounts.js";
import { userRoutes } from "./routes/users.js";
import { planRoutes } from "./routes/plans.js";
import { consumeRoutes } from "./routes/consume.js";
import { usageRoutes } from "./routes/usage.js";
import { usageHistoryRoutes } from "./routes/usage-history.js";
export interface AppDeps {
  config: Config;
  pool: Pool;
  db: Db;
  /** Defaults to the system clock; tests inject their own. */
  now?: Clock;
}

export function buildApp({ config, pool, db, now = systemClock }: AppDeps): FastifyInstance {
  const app = Fastify({
    // LOG_LEVEL=silent|warn|info... Every request logs two lines, which costs CPU under load.
    logger: process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info" },
  });
  app.decorateRequest("accountId", "");
  registerErrorHandling(app);

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });

  app.register(accountRoutes({ db, config }), { prefix: "/v1" });
  app.register(userRoutes({ db }), { prefix: "/v1/users" });
  app.register(planRoutes({ db }), { prefix: "/v1/plans" });
  app.register(consumeRoutes({ db, now }), { prefix: "/v1/consume" });
  app.register(usageRoutes({ db, now }), { prefix: "/v1/usage" });
  app.register(usageHistoryRoutes({ db, now }), { prefix: "/v1/usage/history" });
  return app;
}
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config/env.js";
import type { Db, Pool } from "./config/database.js";
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
}


export function buildApp({ config, pool, db }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  app.decorateRequest("accountId", "");
  registerErrorHandling(app);

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });

  app.register(accountRoutes({ db, config }), { prefix: "/v1" });
  app.register(userRoutes({ db }), { prefix: "/v1/users" });
  app.register(planRoutes({ db }), { prefix: "/v1/plans" });
  app.register(consumeRoutes({ db }), { prefix: "/v1/consume" });
  app.register(usageRoutes({ db }), { prefix: "/v1/usage" });
  app.register(usageHistoryRoutes({ db }), {prefix: "/v1/usage/history"});
  return app;
}

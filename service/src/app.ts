import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config/env.js";
import type { Db, Pool } from "./config/database.js";
import { registerErrorHandling } from "./middlewares/error-handler.js";
import { accountRoutes } from "./routes/accounts.js";
import { userRoutes } from "./routes/users.js";

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
  return app;
}

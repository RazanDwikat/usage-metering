import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../config/database.js";
import type { Config } from "../config/env.js";
import { requireAdmin } from "../middlewares/admin-auth.js";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import { createAccountBody } from "../schemas/accounts.js";
import { createAccount, getAccount } from "../services/account.service.js";

export const accountRoutes = (deps: { db: Db; config: Config }): FastifyPluginAsync => async (app) => {
  const { db, config } = deps;

  // Operator-only: creates an account and returns its API key (the only time the key is ever shown).
  app.post("/accounts", { preHandler: requireAdmin(config.ADMIN_TOKEN) }, async (req, reply) => {
    const body = createAccountBody.parse(req.body);
    const created = await createAccount(db, body);
    return reply.status(201).header("cache-control", "no-store").send(created);
  });

  // The calling account (identified by its API key) and its current plan.
  app.get("/account", { preHandler: requireApiKey(db) }, async (req) => {
    return { account: await getAccount(db, req.accountId) };
  });
};

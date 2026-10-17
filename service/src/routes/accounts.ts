import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../config/database.js";
import type { Config } from "../config/env.js";
import { requireAdmin } from "../middlewares/admin-auth.js";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import { changeAccountPlan, createAccount, getAccount } from "../services/account.service.js";
import { createApiKey, getApiKeys, revokeApiKey } from "../services/api-key.service.js";
import { createAccountBody, updateAccountPlanBody } from "../validators/accounts.js";
import { uuidParams } from "../validators/common.js";

export const accountRoutes =
  (deps: { db: Db; config: Config }): FastifyPluginAsync =>
  async (app) => {
    const { db, config } = deps;

    // Operator-only: creates an account and returns its API key (the only time that key is ever shown).
    app.post("/accounts", { onRequest: requireAdmin(config.ADMIN_TOKEN) }, async (req, reply) => {
      const body = createAccountBody.parse(req.body);
      const created = await createAccount(db, body);
      return reply.status(201).header("cache-control", "no-store").send(created);
    });

    // Everything below acts on the calling account, identified by its API key.
    // Authentication runs in onRequest, i.e. before the body is parsed: no key, no processing.
    const auth = { onRequest: requireApiKey(db) };

    app.get("/account", auth, async (req) => ({ account: await getAccount(db, req.accountId) }));

    app.put("/account/plan", auth, async (req) => {
      const body = updateAccountPlanBody.parse(req.body);
      return { account: await changeAccountPlan(db, req.accountId, body.planId) };
    });

    app.get("/account/api-keys", auth, async (req) => ({ apiKeys: await getApiKeys(db, req.accountId) }));

    app.post("/account/api-keys", auth, async (req, reply) => {
      const apiKey = await createApiKey(db, req.accountId);
      return reply.status(201).header("cache-control", "no-store").send({ apiKey });
    });

    app.delete("/account/api-keys/:id", auth, async (req, reply) => {
      const { id } = uuidParams.parse(req.params);
      await revokeApiKey(db, req.accountId, id);
      return reply.status(204).send();
    });
  };

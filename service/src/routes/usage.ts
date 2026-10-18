import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../config/database.js";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import { getUsage, getUsersUsage } from "../services/usage.service.js";
import { usageQuery, usageUsersQuery } from "../validators/usage.js";
import type { Clock } from "../lib/time.js";

export const usageRoutes =
  (deps: { db: Db; now: Clock }): FastifyPluginAsync =>
  async (app) => {
    const { db, now } = deps;

    app.addHook("onRequest", requireApiKey(db));

    // The account's usage for a month, plus one user's when ?externalId= is given.
    app.get("/", async (req) => ({ usage: await getUsage(db, req.accountId, usageQuery.parse(req.query), now) }));

    // Every user's usage for a month (paginated).
    app.get("/users", async (req) => getUsersUsage(db, req.accountId, usageUsersQuery.parse(req.query), now));
  };

import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../config/database.js";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import { getUsage } from "../services/usage.service.js";
import { usageQuery } from "../validators/usage.js";

export const usageRoutes = (
  deps: { db: Db },
): FastifyPluginAsync => async (app) => {
  const { db } = deps;

  app.addHook("preHandler", requireApiKey(db));

  app.get("/", async (req) => {
    const query = usageQuery.parse(req.query);

    return {
      usage: await getUsage(db, req.accountId, query),
    };
  });
};

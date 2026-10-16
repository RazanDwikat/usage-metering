
import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../config/database.js";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import { getUsageHistory } from "../services/usage-history.service.js";
import { usageHistoryQuery } from "../validators/usage-history.js";

export const usageHistoryRoutes = (
  deps: { db: Db },
): FastifyPluginAsync => async (app) => {
  const { db } = deps;

  app.addHook("preHandler", requireApiKey(db));

  app.get("/", async (req) => {
    const query = usageHistoryQuery.parse(req.query);

    return {
      history: await getUsageHistory(db, req.accountId, query),
    };
  });
};

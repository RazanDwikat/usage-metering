
import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../config/database.js";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import { consumeBody } from "../validators/consume.js";
import { consume } from "../services/consume.service.js";

export const consumeRoutes = (deps: {
  db: Db;
}): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;

    app.addHook("preHandler", requireApiKey(db));

    app.post("/", async (req) => {
      const body = consumeBody.parse(req.body);

      const result = await consume(db, req.accountId, body);

      return result;
    });
  };

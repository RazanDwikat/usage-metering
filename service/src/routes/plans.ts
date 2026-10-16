
import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../config/database.js";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import {
  createPlanBody,
  updatePlanBody,
} from "../validators/plans.js";
import {
  archivePlan,
  changePlan,
  createPlan,
  getPlan,
  getPlans,
} from "../services/plan.service.js";
import { z } from "zod";

const planIdParams = (params: unknown): string => {
  return z
    .object({
      id: z.uuid(),
    })
    .parse(params).id;
};

export const planRoutes = (deps: {
  db: Db;
}): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;

    app.addHook("preHandler", requireApiKey(db));

    app.get("/", async (req) => {
      const plans = await getPlans(db, req.accountId);
      return { plans };
    });

    app.get("/:id", async (req) => {
      const id = planIdParams(req.params);
      const plan = await getPlan(db, req.accountId, id);
      return { plan };
    });

    app.post("/", async (req, reply) => {
      const body = createPlanBody.parse(req.body);
      const plan = await createPlan(db, req.accountId, body);

      return reply.status(201).send({ plan });
    });

    app.patch("/:id", async (req) => {
      const id = planIdParams(req.params);
      const body = updatePlanBody.parse(req.body);

      const plan = await changePlan(
        db,
        req.accountId,
        id,
        body,
      );

      return { plan };
    });

    app.delete("/:id", async (req, reply) => {
      const id = planIdParams(req.params);

      await archivePlan(db, req.accountId, id);

      return reply.status(204).send();
    });
  };

import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../config/database.js";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import { archivePlan, changePlan, createPlan, getPlan, getPlans } from "../services/plan.service.js";
import { uuidParams } from "../validators/common.js";
import { createPlanBody, updatePlanBody } from "../validators/plans.js";

export const planRoutes =
  (deps: { db: Db }): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;

    app.addHook("onRequest", requireApiKey(db));

    app.get("/", async (req) => ({ plans: await getPlans(db, req.accountId) }));

    app.get("/:id", async (req) => {
      const { id } = uuidParams.parse(req.params);
      return { plan: await getPlan(db, req.accountId, id) };
    });

    app.post("/", async (req, reply) => {
      const body = createPlanBody.parse(req.body);
      return reply.status(201).send({ plan: await createPlan(db, req.accountId, body) });
    });

    app.patch("/:id", async (req) => {
      const { id } = uuidParams.parse(req.params);
      const body = updatePlanBody.parse(req.body);
      return { plan: await changePlan(db, req.accountId, id, body) };
    });

    // Archives (soft-deletes) the plan; history that refers to it is preserved.
    app.delete("/:id", async (req, reply) => {
      const { id } = uuidParams.parse(req.params);
      await archivePlan(db, req.accountId, id);
      return reply.status(204).send();
    });
  };

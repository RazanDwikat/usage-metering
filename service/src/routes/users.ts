import type { FastifyPluginAsync } from "fastify";
import type { Db } from "../config/database.js";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import { changeUserPlan, createUser, deleteUser, getUser, getUsers } from "../services/user.service.js";
import { uuidParams } from "../validators/common.js";
import { createUserBody, listUsersQuery, updateUserPlanBody } from "../validators/users.js";

export const userRoutes =
  (deps: { db: Db }): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;

    app.addHook("onRequest", requireApiKey(db));

    app.post("/", async (req, reply) => {
      const body = createUserBody.parse(req.body);
      return reply.status(201).send({ user: await createUser(db, req.accountId, body) });
    });

    app.get("/", async (req) => getUsers(db, req.accountId, listUsersQuery.parse(req.query)));

    app.get("/:id", async (req) => {
      const { id } = uuidParams.parse(req.params);
      return { user: await getUser(db, req.accountId, id) };
    });

    app.put("/:id/plan", async (req) => {
      const { id } = uuidParams.parse(req.params);
      const body = updateUserPlanBody.parse(req.body);
      return { user: await changeUserPlan(db, req.accountId, id, body.planId) };
    });

    app.delete("/:id", async (req, reply) => {
      const { id } = uuidParams.parse(req.params);
      await deleteUser(db, req.accountId, id);
      return reply.status(204).send();
    });
  };

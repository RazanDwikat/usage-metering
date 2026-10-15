import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Db } from "../config/database.js";
import { requireApiKey } from "../middlewares/api-key-auth.js";
import {
  createUserBody,
  updateUserPlanBody,
} from "../validators/users.js";
import {
  changeUserPlan,
  createUser,
  deleteUser,
  getUser,
  getUsers,
} from "../services/user.service.js";

const userIdParams = (params: unknown): string => {
  return z.object({
    id: z.uuid(),
  }).parse(params).id;
};

export const userRoutes = (deps: { db: Db }): FastifyPluginAsync =>
  async (app) => {
    const { db } = deps;

    app.addHook("preHandler", requireApiKey(db));

    app.post("/", async (req, reply) => {
      const body = createUserBody.parse(req.body);
      const user = await createUser(db, req.accountId, body);

      return reply.status(201).send({ user });
    });

    app.get("/", async (req) => {
      const users = await getUsers(db, req.accountId);

      return { users };
    });

    app.get("/:id", async (req) => {
      const id = userIdParams(req.params);
      const user = await getUser(db, req.accountId, id);

      return { user };
    });

    app.patch("/:id/plan", async (req) => {
      const id = userIdParams(req.params);
      const body = updateUserPlanBody.parse(req.body);

      const user = await changeUserPlan(
        db,
        req.accountId,
        id,
        body.planId,
      );

      return { user };
    });

    app.delete("/:id", async (req, reply) => {
      const id = userIdParams(req.params);

      await deleteUser(db, req.accountId, id);

      return reply.status(204).send();
    });
  };

import { z } from "zod";
import { externalIdField, pagination } from "./common.js";

export const createUserBody = z.strictObject({
  externalId: externalIdField,
  planId: z.uuid().optional(),
});

export const updateUserPlanBody = z.strictObject({
  planId: z.uuid(),
});

export const listUsersQuery = z.strictObject(pagination(50, 200));

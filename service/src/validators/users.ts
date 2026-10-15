import { z } from "zod";

export const createUserBody = z.strictObject({
  externalId: z.string().trim().min(1).max(200),
  planId: z.uuid().optional(),
});

export const updateUserPlanBody = z.strictObject({
  planId: z.uuid(),
});

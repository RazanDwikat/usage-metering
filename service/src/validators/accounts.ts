import { z } from "zod";

export const createAccountBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  planId: z.uuid().optional(),
});

export const updateAccountPlanBody = z.strictObject({
  planId: z.uuid(),
});

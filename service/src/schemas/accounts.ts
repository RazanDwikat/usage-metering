import { z } from "zod";

/** strictObject: unknown fields are an error, so a typo like "plan" instead of "planId" is not silently ignored. */
export const createAccountBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  planId: z.uuid().optional(),
});


import { z } from "zod";

export const usageHistoryQuery = z.strictObject({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must use YYYY-MM format")
    .optional(),

  externalId: z.string().trim().min(1).max(200).optional(),

  limit: z.coerce.number().int().min(1).max(100).default(20),

  offset: z.coerce.number().int().min(0).default(0),
});

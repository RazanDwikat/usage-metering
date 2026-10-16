
import { z } from "zod";

export const usageQuery = z.strictObject({
  month: z.string().regex(
    /^\d{4}-(0[1-9]|1[0-2])$/,
    "month must use YYYY-MM format",
  ).optional(),

  externalId: z.string().trim().min(1).max(200).optional(),
});

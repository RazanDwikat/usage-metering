
import { z } from "zod";

export const consumeBody = z.strictObject({
  requestId: z.string().trim().min(1).max(200),
  externalId: z.string().trim().min(1).max(200),
  units: z.number().int().positive(),
});

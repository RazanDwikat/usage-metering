import { z } from "zod";
import { positiveInt } from "../lib/limits.js";

const planFields = {
  name: z.string().trim().min(1).max(100),
  scope: z.enum(["account", "user"]),
  monthlyLimit: positiveInt(),
  maxPerRequest: positiveInt(),
};

export const createPlanBody = z.strictObject(planFields).refine((p) => p.maxPerRequest <= p.monthlyLimit, {
  message: "maxPerRequest cannot exceed monthlyLimit",
  path: ["maxPerRequest"],
});

export const updatePlanBody = z
  .strictObject({
    name: planFields.name.optional(),
    monthlyLimit: planFields.monthlyLimit.optional(),
    maxPerRequest: planFields.maxPerRequest.optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: "At least one field must be provided" })
  .refine(
    (p) => p.monthlyLimit === undefined || p.maxPerRequest === undefined || p.maxPerRequest <= p.monthlyLimit,
    {
      message: "maxPerRequest cannot exceed monthlyLimit when both are provided",
      path: ["maxPerRequest"],
    },
  );

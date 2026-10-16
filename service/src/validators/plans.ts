
import { z } from "zod";

const planScope = z.enum(["account", "user"]);

const planFields = {
  name: z.string().trim().min(1).max(100),
  scope: planScope,
  monthlyLimit: z.number().int().positive(),
  maxPerRequest: z.number().int().positive(),
};

export const createPlanBody = z
  .strictObject(planFields)
  .refine(
    (plan) => plan.maxPerRequest <= plan.monthlyLimit,
    {
      message: "maxPerRequest cannot exceed monthlyLimit",
      path: ["maxPerRequest"],
    },
  );

export const updatePlanBody = z
  .strictObject({
    name: planFields.name.optional(),
    monthlyLimit: planFields.monthlyLimit.optional(),
    maxPerRequest: planFields.maxPerRequest.optional(),
  })
  .refine(
    (plan) => Object.keys(plan).length > 0,
    { message: "At least one field must be provided" },
  )
  .refine(
    (plan) =>
      plan.monthlyLimit === undefined ||
      plan.maxPerRequest === undefined ||
      plan.maxPerRequest <= plan.monthlyLimit,
    {
      message:
        "maxPerRequest cannot exceed monthlyLimit when both are provided",
      path: ["maxPerRequest"],
    },
  );

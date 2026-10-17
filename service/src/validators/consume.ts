import { z } from "zod";
import { externalIdField } from "./common.js";
import { positiveInt } from "../lib/limits.js";

export const consumeBody = z.strictObject({
  requestId: z.string().trim().min(1).max(200),
  externalId: externalIdField,
  units: positiveInt(),
});

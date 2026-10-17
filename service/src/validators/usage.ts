import { z } from "zod";
import { externalIdField, monthParam, pagination } from "./common.js";

export const usageQuery = z.strictObject({
  month: monthParam.optional(),
  externalId: externalIdField.optional(),
});

export const usageUsersQuery = z.strictObject({
  month: monthParam.optional(),
  ...pagination(50, 200),
});

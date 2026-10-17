import { z } from "zod";
import { externalIdField, monthParam, pagination } from "./common.js";

export const usageHistoryQuery = z.strictObject({
  month: monthParam.optional(),
  externalId: externalIdField.optional(),
  ...pagination(20, 100),
});

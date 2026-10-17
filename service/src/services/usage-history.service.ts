import type { Db } from "../config/database.js";
import { countConsumeHistory, listConsumeHistory } from "../repositories/consume.repo.js";
import { BadRequestError, NotFoundError } from "../errors/app-error.js";
import { monthStart, parseMonth } from "../lib/time.js";
import { findAccountWithPlan } from "../repositories/accounts.repo.js";

interface UsageHistoryInput {
  month?: string;
  externalId?: string;
  limit: number;
  offset: number;
}

export async function getUsageHistory(db: Db, accountId: string, input: UsageHistoryInput) {
  const windowStart = input.month ? parseMonth(input.month) : monthStart(new Date());

  if (!windowStart) {
    throw new BadRequestError("invalid_month", "month must use YYYY-MM format");
  }

  const account = await findAccountWithPlan(db, accountId);

  if (!account) {
    throw new NotFoundError("account_not_found", "Account not found");
  }

  const filters = { accountId, windowStart, externalId: input.externalId };
  const [items, total] = await Promise.all([
    listConsumeHistory(db, { ...filters, limit: input.limit, offset: input.offset }),
    countConsumeHistory(db, filters),
  ]);

  return {
    period: windowStart.slice(0, 7),
    pagination: { limit: input.limit, offset: input.offset, returned: items.length, total },
    items,
  };
}

import type { Db } from "../config/database.js";
import { findAccountWithPlan } from "../repositories/accounts.repo.js";
import { getUsageCounter, listUsersUsage } from "../repositories/usage.repo.js";
import { countActiveUsers, findUserByExternalId } from "../repositories/users.repo.js";
import { findPlanById } from "../repositories/plans.repo.js";
import { BadRequestError, NotFoundError } from "../errors/app-error.js";
import { remaining } from "../rules/monthly-allowance.js";
import { monthStart, parseMonth, systemClock, type Clock } from "../lib/time.js";

interface UsageInput {
  month?: string;
  externalId?: string;
}

export async function getUsage(db: Db, accountId: string, input: UsageInput = {}, now: Clock = systemClock) {
  const windowStart = input.month ? parseMonth(input.month) : monthStart(now());

  if (!windowStart) {
    throw new BadRequestError("invalid_month", "month must use YYYY-MM format");
  }

  const accountData = await findAccountWithPlan(db, accountId);

  if (!accountData) {
    throw new NotFoundError("account_not_found", "Account not found");
  }

  const accountPlan = accountData.plan;

  const accountCounter = await getUsageCounter(db, accountId, null, windowStart);

  const accountUsed = accountCounter?.used ?? 0;

  const result: {
    period: string;
    account: {
      limit: number;
      used: number;
      remaining: number;
    };
    user?: {
      externalId: string;
      limit: number;
      used: number;
      remaining: number;
    };
  } = {
    period: windowStart.slice(0, 7),
    account: {
      limit: accountPlan.monthlyLimit,
      used: accountUsed,
      remaining: Math.max(0, accountPlan.monthlyLimit - accountUsed),
    },
  };

  if (input.externalId !== undefined) {
    const user = await findUserByExternalId(db, accountId, input.externalId);

    if (!user) {
      throw new NotFoundError("user_not_found", "User not found");
    }

    const userPlan = await findPlanById(db, user.planId);

    if (
      !userPlan ||
      userPlan.scope !== "user" ||
      userPlan.archivedAt !== null ||
      (userPlan.ownerAccountId !== null && userPlan.ownerAccountId !== accountId)
    ) {
      throw new NotFoundError("user_plan_not_found", "User plan not found");
    }

    const userCounter = await getUsageCounter(db, accountId, user.id, windowStart);

    const userUsed = userCounter?.used ?? 0;

    result.user = {
      externalId: user.externalId,
      limit: userPlan.monthlyLimit,
      used: userUsed,
      remaining: Math.max(0, userPlan.monthlyLimit - userUsed),
    };
  }

  return result;
}

interface UsersUsageInput {
  month?: string;
  limit: number;
  offset: number;
}

/** Usage of every active user in a month. Limits shown are those of each user's CURRENT plan. */
export async function getUsersUsage(db: Db, accountId: string, input: UsersUsageInput, now: Clock = systemClock) {
  const windowStart = input.month ? parseMonth(input.month) : monthStart(now());
  if (!windowStart) {
    throw new BadRequestError("invalid_month", "month must use YYYY-MM format");
  }

  const page = { limit: input.limit, offset: input.offset };
  const [rows, total] = await Promise.all([
    listUsersUsage(db, accountId, windowStart, page),
    countActiveUsers(db, accountId),
  ]);

  return {
    period: windowStart.slice(0, 7),
    pagination: { ...page, total },
    users: rows.map((r) => ({
      externalId: r.externalId,
      plan: { id: r.planId, name: r.planName },
      limit: r.monthlyLimit,
      used: r.used,
      remaining: remaining(r.monthlyLimit, r.used),
    })),
  };
}

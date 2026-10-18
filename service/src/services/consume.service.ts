import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../config/database.js";
import { findAccountWithPlan } from "../repositories/accounts.repo.js";
import { findConsumeRequest, insertConsumeRequest } from "../repositories/consume.repo.js";
import { findPlansByIdsForShare, type PlanRow } from "../repositories/plans.repo.js";
import { findUserByExternalId, findUserByExternalIdForUpdate } from "../repositories/users.repo.js";
import { getOrCreateCounterForUpdate, incrementCounters } from "../repositories/usage.repo.js";
import { users } from "../db/schema.js";
import { ConflictError, NotFoundError } from "../errors/app-error.js";
import { monthStart, systemClock, type Clock } from "../lib/time.js";
import { evaluate } from "../rules/evaluate.js";
import { remaining } from "../rules/monthly-allowance.js";

export interface ConsumeInput {
  requestId: string;
  externalId: string;
  units: number;
}

function toConsumeResult(
  replayed: boolean,
  row: {
    requestId: string;
    units: number;
    windowStart: string;
    accepted: boolean;
    rejectScope: "account" | "user" | null;
    rejectRule: "monthly_allowance" | "max_per_request" | null;
    accountRemaining: number;
    userRemaining: number;
    accountMonthlyLimit: number;
    accountMaxPerRequest: number;
    userMonthlyLimit: number;
    userMaxPerRequest: number;
  },
) {
  const rejectionLimit =
    row.rejectScope === null || row.rejectRule === null
      ? null
      : row.rejectRule === "max_per_request"
        ? row.rejectScope === "account"
          ? row.accountMaxPerRequest
          : row.userMaxPerRequest
        : row.rejectScope === "account"
          ? row.accountMonthlyLimit
          : row.userMonthlyLimit;

  return {
    requestId: row.requestId,
    replayed,
    accepted: row.accepted,
    units: row.units,
    windowStart: row.windowStart,
    remaining: {
      account: row.accountRemaining,
      user: row.userRemaining,
    },
    rejection:
      row.accepted || row.rejectScope === null || row.rejectRule === null
        ? null
        : {
            scope: row.rejectScope,
            rule: row.rejectRule,
            limit: rejectionLimit,
          },
  };
}

function isUsablePlan(plan: PlanRow, scope: "account" | "user", accountId: string): boolean {
  return (
    plan.scope === scope &&
    (plan.ownerAccountId === null || plan.ownerAccountId === accountId) &&
    plan.archivedAt === null
  );
}

/** How many times a request is re-run when the user's plan changed between our unlocked read and our lock. */
const MAX_ATTEMPTS = 3;

/**
 * Decides one consume request. Nothing is recorded by a failed attempt (the whole transaction rolls back),
 * so when the user's plan was switched while we were about to lock it we simply start over with the new plan:
 * the caller only sees a 409 `user_plan_changed` if the plan keeps changing under us for several attempts in a row.
 */
export async function consume(db: Db, accountId: string, input: ConsumeInput, now: Clock = systemClock) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await consumeOnce(db, accountId, input, now);
    } catch (err) {
      const planChanged = err instanceof ConflictError && err.code === "user_plan_changed";
      if (!planChanged || attempt >= MAX_ATTEMPTS) throw err;
    }
  }
}

async function consumeOnce(db: Db, accountId: string, input: ConsumeInput, now: Clock) {
  return db.transaction(async (tx) => {
    // Serialize retries that use the same account/request ID.
    // A hash collision only causes extra waiting; it does not affect correctness.
    const lockKey = `${accountId}:${input.requestId}`;

    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${lockKey}, 0)
      )
    `);

    // Idempotency check: a matching retry returns the original decision.
    const previous = await findConsumeRequest(tx, accountId, input.requestId);

    if (previous) {
      const [previousUser] = await tx
        .select({ externalId: users.externalId })
        .from(users)
        .where(and(eq(users.accountId, accountId), eq(users.id, previous.userId)))
        .limit(1);

      if (previous.units !== input.units || previousUser?.externalId !== input.externalId) {
        throw new ConflictError(
          "idempotency_key_reused",
          "This requestId was already used with a different payload",
        );
      }

      return toConsumeResult(true, previous);
    }

    const accountData = await findAccountWithPlan(tx, accountId);

    if (!accountData) {
      throw new NotFoundError("account_not_found", "Account not found");
    }

    // Read the user first, without locking it, to discover its plan ID.
    const initialUser = await findUserByExternalId(tx, accountId, input.externalId);

    if (!initialUser) {
      throw new NotFoundError("user_not_found", "User not found");
    }

    const accountPlanId = accountData.account.planId;
    const userPlanId = initialUser.planId;

    // Share-lock the plans: plan edits/archiving (exclusive) wait for in-flight consumes, but consumes never
    // wait for each other here. (An exclusive lock would serialise every account on a shared predefined plan.)
    // One statement locks both rows, always in id order.
    const planIds = [...new Set([accountPlanId, userPlanId])];
    const lockedPlans = new Map((await findPlansByIdsForShare(tx, planIds)).map((plan) => [plan.id, plan]));

    if (lockedPlans.size !== planIds.length) {
      throw new NotFoundError("plan_not_found", "Plan not found");
    }

    const accountPlan = lockedPlans.get(accountPlanId);
    const userPlan = lockedPlans.get(userPlanId);

    if (!accountPlan || !isUsablePlan(accountPlan, "account", accountId)) {
      throw new ConflictError("account_plan_unavailable", "The account plan is unavailable");
    }

    if (!userPlan || !isUsablePlan(userPlan, "user", accountId)) {
      throw new ConflictError("user_plan_unavailable", "The user plan is unavailable");
    }

    // Lock the user only after locking the plan rows.
    const currentUser = await findUserByExternalIdForUpdate(tx, accountId, input.externalId);

    if (!currentUser) {
      throw new NotFoundError("user_not_found", "User not found");
    }

    // The user might have changed plans between the initial read and the lock.
    if (currentUser.id !== initialUser.id || currentUser.planId !== userPlanId) {
      throw new ConflictError(
        "user_plan_changed",
        "The user's plan changed during this request; please retry",
      );
    }

    const windowStart = monthStart(now());

    // Lock counters in one fixed order for every request: the user's counter, then the shared account counter.
    // The account counter is the hot lock (every request of the account takes it), so it is taken as late as
    // possible: the less work happens between taking it and COMMIT, the more requests per second one account can do.
    const userCounter = await getOrCreateCounterForUpdate(tx, {
      accountId,
      userId: currentUser.id,
      windowStart,
    });

    const accountCounter = await getOrCreateCounterForUpdate(tx, {
      accountId,
      userId: null,
      windowStart,
    });

    const limits = {
      account: {
        monthlyLimit: accountPlan.monthlyLimit,
        maxPerRequest: accountPlan.maxPerRequest,
      },
      user: {
        monthlyLimit: userPlan.monthlyLimit,
        maxPerRequest: userPlan.maxPerRequest,
      },
    };

    const usage = {
      account: accountCounter.used,
      user: userCounter.used,
    };

    const decision = evaluate({
      units: input.units,
      limits,
      usage,
    });

    // Accepted requests report remaining quota after consumption.
    // Rejected requests report the quota remaining before this attempt.
    const accountRemaining = remaining(
      limits.account.monthlyLimit,
      usage.account + (decision.accepted ? input.units : 0),
    );

    const userRemaining = remaining(
      limits.user.monthlyLimit,
      usage.user + (decision.accepted ? input.units : 0),
    );

    if (decision.accepted) {
      await incrementCounters(tx, [accountCounter.id, userCounter.id], input.units);
    }

    const recorded = await insertConsumeRequest(tx, {
      accountId,
      userId: currentUser.id,
      requestId: input.requestId,
      units: input.units,
      windowStart,
      accepted: decision.accepted,
      rejectScope: decision.accepted ? null : decision.scope,
      rejectRule: decision.accepted ? null : decision.rule,
      accountPlanId: accountPlan.id,
      userPlanId: userPlan.id,
      accountMonthlyLimit: limits.account.monthlyLimit,
      accountMaxPerRequest: limits.account.maxPerRequest,
      userMonthlyLimit: limits.user.monthlyLimit,
      userMaxPerRequest: limits.user.maxPerRequest,
      accountRemaining,
      userRemaining,
    });

    return toConsumeResult(false, recorded);
  });
}
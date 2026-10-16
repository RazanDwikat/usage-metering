
import type { Db, Executor } from "../config/database.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../errors/app-error.js";
import {
  findPlanById,
  findPlanByIdForUpdate,
  findPredefinedPlan,
  type PlanRow,
} from "../repositories/plans.repo.js";
import {
  findUserByExternalId,
  findUserById,
  insertUser,
  listUsers,
  softDeleteUser,
  updateUserPlan,
  type UserRow,
} from "../repositories/users.repo.js";

export const DEFAULT_USER_PLAN = "Basic";

export interface UserView {
  id: string;
  externalId: string;
  createdAt: string;
  plan: {
    id: string;
    name: string;
    scope: "account" | "user";
    monthlyLimit: number;
    maxPerRequest: number;
    predefined: boolean;
  };
}

function toUserView(user: UserRow, plan: PlanRow): UserView {
  return {
    id: user.id,
    externalId: user.externalId,
    createdAt: user.createdAt.toISOString(),
    plan: {
      id: plan.id,
      name: plan.name,
      scope: plan.scope,
      monthlyLimit: plan.monthlyLimit,
      maxPerRequest: plan.maxPerRequest,
      predefined: plan.ownerAccountId === null,
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}


async function getUsableUserPlan(
  ex: Executor,
  accountId: string,
  planId?: string,
): Promise<PlanRow> {
  const selectedPlan = planId
    ? await findPlanById(ex, planId)
    : await findPredefinedPlan(ex, "user", DEFAULT_USER_PLAN);

  if (!selectedPlan) {
    throw new NotFoundError("plan_not_found", "Plan not found");
  }

  // Lock the plan row, then validate its current state.
  const plan = await findPlanByIdForUpdate(ex, selectedPlan.id);

  if (!plan || plan.archivedAt !== null) {
    throw new NotFoundError("plan_not_found", "Plan not found");
  }

  if (plan.scope !== "user") {
    throw new BadRequestError(
      "plan_scope_mismatch",
      "Users need a user plan",
    );
  }

  if (
    plan.ownerAccountId !== null &&
    plan.ownerAccountId !== accountId
  ) {
    throw new NotFoundError("plan_not_found", "Plan not found");
  }

  return plan;
}


export async function createUser(
  db: Db,
  accountId: string,
  input: { externalId: string; planId?: string },
): Promise<UserView> {
  try {
    return await db.transaction(async (tx) => {
      const existing = await findUserByExternalId(
        tx,
        accountId,
        input.externalId,
      );

      if (existing) {
        throw new ConflictError(
          "user_already_exists",
          "A user with this externalId already exists",
        );
      }

      const plan = await getUsableUserPlan(
        tx,
        accountId,
        input.planId,
      );

      const user = await insertUser(tx, {
        accountId,
        externalId: input.externalId,
        planId: plan.id,
      });

      return toUserView(user, plan);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "user_already_exists",
        "A user with this externalId already exists",
      );
    }

    throw error;
  }
}

export async function getUser(
  db: Db,
  accountId: string,
  userId: string,
): Promise<UserView> {
  const user = await findUserById(db, accountId, userId);

  if (!user) {
    throw new NotFoundError("user_not_found", "User not found");
  }

  const plan = await findPlanById(db, user.planId);

  if (!plan) {
    throw new Error("User plan is missing from the database");
  }

  return toUserView(user, plan);
}

export async function getUsers(
  db: Db,
  accountId: string,
): Promise<UserView[]> {
  const rows = await listUsers(db, accountId);

  return Promise.all(
    rows.map(async (user) => {
      const plan = await findPlanById(db, user.planId);

      if (!plan) {
        throw new Error("User plan is missing from the database");
      }

      return toUserView(user, plan);
    }),
  );
}

export async function changeUserPlan(
  db: Db,
  accountId: string,
  userId: string,
  planId: string,
): Promise<UserView> {
  return db.transaction(async (tx) => {
    const user = await findUserById(tx, accountId, userId);

    if (!user) {
      throw new NotFoundError("user_not_found", "User not found");
    }

    const plan = await getUsableUserPlan(
      tx,
      accountId,
      planId,
    );

    const updated = await updateUserPlan(
      tx,
      accountId,
      userId,
      plan.id,
    );

    if (!updated) {
      throw new NotFoundError("user_not_found", "User not found");
    }

    return toUserView(updated, plan);
  });
}

export async function deleteUser(
  db: Db,
  accountId: string,
  userId: string,
): Promise<void> {
  const deleted = await softDeleteUser(db, accountId, userId);

  if (!deleted) {
    throw new NotFoundError("user_not_found", "User not found");
  }
}


import type { Db, Executor } from "../config/database.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../errors/app-error.js";
import {
  archivePlan as archivePlanRepo,
  findPlanById,
  findPlanByIdForUpdate,
  insertPlan,
  isPlanAssignedToActiveEntities,
  listPlans,
  updatePlan as updatePlanRepo,
  type PlanRow,
} from "../repositories/plans.repo.js";

export interface PlanView {
  id: string;
  name: string;
  scope: "account" | "user";
  monthlyLimit: number;
  maxPerRequest: number;
  predefined: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type CreatePlanInput = {
  name: string;
  scope: "account" | "user";
  monthlyLimit: number;
  maxPerRequest: number;
};

type UpdatePlanInput = {
  name?: string;
  monthlyLimit?: number;
  maxPerRequest?: number;
};

function toPlanView(plan: PlanRow): PlanView {
  return {
    id: plan.id,
    name: plan.name,
    scope: plan.scope,
    monthlyLimit: plan.monthlyLimit,
    maxPerRequest: plan.maxPerRequest,
    predefined: plan.ownerAccountId === null,
    archivedAt: plan.archivedAt?.toISOString() ?? null,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}


function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if ("code" in error && error.code === "23505") {
    return true;
  }

  if ("cause" in error) {
    return isUniqueViolation(error.cause);
  }

  return false;
}


async function findVisiblePlan(
  ex: Executor,
  accountId: string,
  planId: string,
): Promise<PlanRow> {
  const plan = await findPlanById(ex, planId);

  if (
    !plan ||
    (plan.ownerAccountId !== null &&
      plan.ownerAccountId !== accountId)
  ) {
    throw new NotFoundError("plan_not_found", "Plan not found");
  }

  return plan;
}

async function findOwnedActivePlan(
  ex: Executor,
  accountId: string,
  planId: string,
): Promise<PlanRow> {
  const plan = await findPlanByIdForUpdate(ex, planId);

  if (
    !plan ||
    plan.ownerAccountId !== accountId ||
    plan.archivedAt !== null
  ) {
    throw new NotFoundError("plan_not_found", "Plan not found");
  }

  return plan;
}

export async function getPlans(
  db: Db,
  accountId: string,
): Promise<PlanView[]> {
  const rows = await listPlans(db, accountId);
  return rows.map(toPlanView);
}

export async function getPlan(
  db: Db,
  accountId: string,
  planId: string,
): Promise<PlanView> {
  const plan = await findVisiblePlan(db, accountId, planId);
  return toPlanView(plan);
}

export async function createPlan(
  db: Db,
  accountId: string,
  input: CreatePlanInput,
): Promise<PlanView> {
  try {
    const plan = await insertPlan(db, {
      ownerAccountId: accountId,
      name: input.name,
      scope: input.scope,
      monthlyLimit: input.monthlyLimit,
      maxPerRequest: input.maxPerRequest,
    });

    return toPlanView(plan);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "plan_name_already_exists",
        "A plan with this name and scope already exists",
      );
    }

    throw error;
  }
}

export async function changePlan(
  db: Db,
  accountId: string,
  planId: string,
  input: UpdatePlanInput,
): Promise<PlanView> {
  try {
    return await db.transaction(async (tx) => {
      const current = await findOwnedActivePlan(
        tx,
        accountId,
        planId,
      );

      const monthlyLimit =
        input.monthlyLimit ?? current.monthlyLimit;

      const maxPerRequest =
        input.maxPerRequest ?? current.maxPerRequest;

      if (maxPerRequest > monthlyLimit) {
        throw new BadRequestError(
          "invalid_plan_limits",
          "maxPerRequest cannot exceed monthlyLimit",
        );
      }

      const updated = await updatePlanRepo(
        tx,
        accountId,
        planId,
        input,
      );

      if (!updated) {
        throw new NotFoundError(
          "plan_not_found",
          "Plan not found",
        );
      }

      return toPlanView(updated);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "plan_name_already_exists",
        "A plan with this name and scope already exists",
      );
    }

    throw error;
  }
}

export async function archivePlan(
  db: Db,
  accountId: string,
  planId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await findOwnedActivePlan(tx, accountId, planId);

    const assigned = await isPlanAssignedToActiveEntities(
      tx,
      planId,
    );

    if (assigned) {
      throw new ConflictError(
        "plan_in_use",
        "Cannot archive a plan assigned to an active account or user",
      );
    }

    const archived = await archivePlanRepo(
      tx,
      accountId,
      planId,
    );

    if (!archived) {
      throw new NotFoundError(
        "plan_not_found",
        "Plan not found",
      );
    }
  });
}

import type { Db, Executor } from "../config/database.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors/app-error.js";
import { isUniqueViolation } from "../lib/db-errors.js";
import { toPlanDetailView, type PlanDetailView } from "../views/plan.js";
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

async function findVisiblePlan(ex: Executor, accountId: string, planId: string): Promise<PlanRow> {
  const plan = await findPlanById(ex, planId);

  if (!plan || (plan.ownerAccountId !== null && plan.ownerAccountId !== accountId)) {
    throw new NotFoundError("plan_not_found", "Plan not found");
  }

  return plan;
}

/** Locks and returns a plan the caller may modify. Predefined plans are visible but read-only (403). */
async function findOwnedActivePlan(ex: Executor, accountId: string, planId: string): Promise<PlanRow> {
  const plan = await findPlanByIdForUpdate(ex, planId);

  if (!plan || (plan.ownerAccountId !== null && plan.ownerAccountId !== accountId)) {
    throw new NotFoundError("plan_not_found", "Plan not found");
  }
  if (plan.ownerAccountId === null) {
    throw new ForbiddenError("plan_read_only", "Predefined plans are read-only");
  }
  if (plan.archivedAt !== null) {
    throw new NotFoundError("plan_not_found", "Plan not found");
  }

  return plan;
}

export async function getPlans(db: Db, accountId: string): Promise<PlanDetailView[]> {
  const rows = await listPlans(db, accountId);
  return rows.map(toPlanDetailView);
}

export async function getPlan(db: Db, accountId: string, planId: string): Promise<PlanDetailView> {
  const plan = await findVisiblePlan(db, accountId, planId);
  return toPlanDetailView(plan);
}

export async function createPlan(db: Db, accountId: string, input: CreatePlanInput): Promise<PlanDetailView> {
  try {
    const plan = await insertPlan(db, {
      ownerAccountId: accountId,
      name: input.name,
      scope: input.scope,
      monthlyLimit: input.monthlyLimit,
      maxPerRequest: input.maxPerRequest,
    });

    return toPlanDetailView(plan);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("plan_name_already_exists", "A plan with this name and scope already exists");
    }

    throw error;
  }
}

export async function changePlan(
  db: Db,
  accountId: string,
  planId: string,
  input: UpdatePlanInput,
): Promise<PlanDetailView> {
  try {
    return await db.transaction(async (tx) => {
      const current = await findOwnedActivePlan(tx, accountId, planId);

      const monthlyLimit = input.monthlyLimit ?? current.monthlyLimit;

      const maxPerRequest = input.maxPerRequest ?? current.maxPerRequest;

      if (maxPerRequest > monthlyLimit) {
        throw new BadRequestError("invalid_plan_limits", "maxPerRequest cannot exceed monthlyLimit");
      }

      const updated = await updatePlanRepo(tx, accountId, planId, input);

      if (!updated) {
        throw new NotFoundError("plan_not_found", "Plan not found");
      }

      return toPlanDetailView(updated);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("plan_name_already_exists", "A plan with this name and scope already exists");
    }

    throw error;
  }
}

export async function archivePlan(db: Db, accountId: string, planId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await findOwnedActivePlan(tx, accountId, planId);

    const assigned = await isPlanAssignedToActiveEntities(tx, planId);

    if (assigned) {
      throw new ConflictError("plan_in_use", "Cannot archive a plan assigned to an active account or user");
    }

    const archived = await archivePlanRepo(tx, accountId, planId);

    if (!archived) {
      throw new NotFoundError("plan_not_found", "Plan not found");
    }
  });
}

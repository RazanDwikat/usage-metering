import type { PlanRow } from "../repositories/plans.repo.js";

/** The plan as embedded in other responses (account, user). */
export interface PlanView {
  id: string;
  name: string;
  scope: "account" | "user";
  monthlyLimit: number;
  maxPerRequest: number;
  predefined: boolean;
}

/** The plan as returned by /v1/plans. */
export interface PlanDetailView extends PlanView {
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const toPlanView = (p: PlanRow): PlanView => ({
  id: p.id,
  name: p.name,
  scope: p.scope,
  monthlyLimit: p.monthlyLimit,
  maxPerRequest: p.maxPerRequest,
  predefined: p.ownerAccountId === null,
});

export const toPlanDetailView = (p: PlanRow): PlanDetailView => ({
  ...toPlanView(p),
  archivedAt: p.archivedAt?.toISOString() ?? null,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

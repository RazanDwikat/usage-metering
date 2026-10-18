/** Why a request was rejected. The same shape is used by POST /v1/consume and by the request history. */
export interface Rejection {
  scope: "account" | "user";
  rule: "monthly_allowance" | "max_per_request";
  /** The value of the rule that stopped the request, as it was when the decision was made. */
  limit: number;
}

/** The columns of a stored decision (consume_requests) that describe a rejection and the limits in force. */
export interface RejectionSource {
  accepted: boolean;
  rejectScope: "account" | "user" | null;
  rejectRule: "monthly_allowance" | "max_per_request" | null;
  accountMonthlyLimit: number;
  accountMaxPerRequest: number;
  userMonthlyLimit: number;
  userMaxPerRequest: number;
}

/** Null for an accepted request; otherwise the rule that failed, which side it belongs to, and its limit. */
export function toRejection(row: RejectionSource): Rejection | null {
  if (row.accepted || row.rejectScope === null || row.rejectRule === null) return null;

  const limit =
    row.rejectRule === "max_per_request"
      ? row.rejectScope === "account"
        ? row.accountMaxPerRequest
        : row.userMaxPerRequest
      : row.rejectScope === "account"
        ? row.accountMonthlyLimit
        : row.userMonthlyLimit;

  return { scope: row.rejectScope, rule: row.rejectRule, limit };
}

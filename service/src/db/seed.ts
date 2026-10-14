import type { Pool } from "../config/database.js";

/** Predefined plans (owner_account_id = NULL => read-only, shared by everyone). */
export const PREDEFINED_PLANS = [
  { scope: "account", name: "Starter", monthlyLimit: 10_000, maxPerRequest: 100 },
  { scope: "account", name: "Pro", monthlyLimit: 100_000, maxPerRequest: 1_000 },
  { scope: "user", name: "Basic", monthlyLimit: 1_000, maxPerRequest: 20 },
  { scope: "user", name: "Premium", monthlyLimit: 10_000, maxPerRequest: 200 },
] as const;

/** Idempotent: safe to run on every startup; never overwrites existing rows. */
export async function seedPredefinedPlans(pool: Pool): Promise<void> {
  for (const p of PREDEFINED_PLANS) {
    await pool.query(
      `INSERT INTO plans (scope, owner_account_id, name, monthly_limit, max_per_request)
       VALUES ($1, NULL, $2, $3, $4)
       ON CONFLICT (scope, name) WHERE owner_account_id IS NULL DO NOTHING`,
      [p.scope, p.name, p.monthlyLimit, p.maxPerRequest],
    );
  }
}

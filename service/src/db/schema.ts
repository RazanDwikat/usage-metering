import {
  bigint,
  boolean,
  customType,
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const planScope = pgEnum("plan_scope", ["account", "user"]);
export const windowType = pgEnum("window_type", ["month"]);
export const ruleName = pgEnum("rule_name", ["monthly_allowance", "max_per_request"]);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  planId: uuid("plan_id").notNull(),
  planScope: planScope("plan_scope").notNull().default("account"),
  createdAt: createdAt(),
});

export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: planScope("scope").notNull(),
  ownerAccountId: uuid("owner_account_id"), // NULL = predefined (read-only)
  name: text("name").notNull(),
  monthlyLimit: integer("monthly_limit").notNull(),
  maxPerRequest: integer("max_per_request").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  keyHash: bytea("key_hash").notNull(),
  prefix: text("prefix").notNull(),
  createdAt: createdAt(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  externalId: text("external_id").notNull(),
  planId: uuid("plan_id").notNull(),
  planScope: planScope("plan_scope").notNull().default("user"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const usageCounters = pgTable("usage_counters", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  accountId: uuid("account_id").notNull(),
  userId: uuid("user_id"), // NULL = shared account counter
  windowType: windowType("window_type").notNull().default("month"),
  windowStart: date("window_start", { mode: "string" }).notNull(),
  used: integer("used").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const consumeRequests = pgTable("consume_requests", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  accountId: uuid("account_id").notNull(),
  userId: uuid("user_id").notNull(),
  requestId: text("request_id").notNull(),
  units: integer("units").notNull(),
  windowStart: date("window_start", { mode: "string" }).notNull(),
  accepted: boolean("accepted").notNull(),
  rejectScope: planScope("reject_scope"),
  rejectRule: ruleName("reject_rule"),
  accountPlanId: uuid("account_plan_id").notNull(),
  userPlanId: uuid("user_plan_id").notNull(),
  accountMonthlyLimit: integer("account_monthly_limit").notNull(),
  accountMaxPerRequest: integer("account_max_per_request").notNull(),
  userMonthlyLimit: integer("user_monthly_limit").notNull(),
  userMaxPerRequest: integer("user_max_per_request").notNull(),
  accountRemaining: integer("account_remaining").notNull(),
  userRemaining: integer("user_remaining").notNull(),
  createdAt: createdAt(),
});

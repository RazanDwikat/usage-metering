-- Used by "is this plan in use?" checks (archiving) and plan-change lookups.
CREATE INDEX users_plan    ON users (plan_id);
CREATE INDEX accounts_plan ON accounts (plan_id);

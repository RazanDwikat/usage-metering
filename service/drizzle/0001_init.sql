-- Initial schema. Requires PostgreSQL 15+ (NULLS NOT DISTINCT) and gen_random_uuid() (PG13+).

CREATE TYPE plan_scope  AS ENUM ('account', 'user');
CREATE TYPE window_type AS ENUM ('month');          -- 'day' can be added later with ALTER TYPE ... ADD VALUE
CREATE TYPE rule_name   AS ENUM ('monthly_allowance', 'max_per_request');

-- accounts.plan_id FK is added after plans exists (circular reference)
CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  plan_id     uuid NOT NULL,
  plan_scope  plan_scope NOT NULL DEFAULT 'account' CHECK (plan_scope = 'account'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope             plan_scope NOT NULL,
  owner_account_id  uuid REFERENCES accounts(id),   -- NULL = predefined (read-only)
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  monthly_limit     integer NOT NULL CHECK (monthly_limit > 0),
  max_per_request   integer NOT NULL CHECK (max_per_request > 0),
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, scope)                                 -- target for composite FKs
);
CREATE UNIQUE INDEX plans_name_per_account ON plans (owner_account_id, scope, name)
  WHERE owner_account_id IS NOT NULL;
CREATE UNIQUE INDEX plans_name_predefined ON plans (scope, name)
  WHERE owner_account_id IS NULL;

ALTER TABLE accounts
  ADD FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  key_hash    bytea NOT NULL UNIQUE,                 -- SHA-256 of the key
  prefix      text NOT NULL,                         -- first chars, display only
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX api_keys_account ON api_keys (account_id);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  plan_id     uuid NOT NULL,
  plan_scope  plan_scope NOT NULL DEFAULT 'user' CHECK (plan_scope = 'user'),
  deleted_at  timestamptz,                           -- soft delete; external_id is never reused
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id),
  UNIQUE (account_id, id),                           -- target for composite FKs
  FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);

-- user_id NULL  => shared account counter
-- user_id set   => that user's counter
CREATE TABLE usage_counters (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id),
  user_id       uuid,
  window_type   window_type NOT NULL DEFAULT 'month',
  window_start  date NOT NULL,                       -- first day of the UTC month
  used          integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, user_id) REFERENCES users (account_id, id),
  CHECK (window_type <> 'month' OR window_start = date_trunc('month', window_start)::date)
);
CREATE UNIQUE INDEX usage_counters_key
  ON usage_counters (account_id, user_id, window_type, window_start) NULLS NOT DISTINCT;

-- Append-only decision log (also the idempotency record)
CREATE TABLE consume_requests (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id),
  user_id       uuid NOT NULL,
  request_id    text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  units         integer NOT NULL CHECK (units > 0),
  window_start  date NOT NULL,
  accepted      boolean NOT NULL,
  reject_scope  plan_scope,
  reject_rule   rule_name,
  -- snapshot of what applied at decision time
  account_plan_id          uuid NOT NULL REFERENCES plans(id),
  user_plan_id             uuid NOT NULL REFERENCES plans(id),
  account_monthly_limit    integer NOT NULL,
  account_max_per_request  integer NOT NULL,
  user_monthly_limit       integer NOT NULL,
  user_max_per_request     integer NOT NULL,
  account_remaining        integer NOT NULL CHECK (account_remaining >= 0),
  user_remaining           integer NOT NULL CHECK (user_remaining >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id),                   -- idempotency
  FOREIGN KEY (account_id, user_id) REFERENCES users (account_id, id),
  CHECK (
    (accepted AND reject_scope IS NULL AND reject_rule IS NULL) OR
    (NOT accepted AND reject_scope IS NOT NULL AND reject_rule IS NOT NULL)
  )
);
CREATE INDEX consume_requests_history ON consume_requests (account_id, created_at DESC, id DESC);
CREATE INDEX consume_requests_user    ON consume_requests (account_id, user_id, created_at DESC, id DESC);

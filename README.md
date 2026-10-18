# Usage Metering and Quota Service

A backend service that other applications call to **track usage and decide whether a user may perform an action**.
An application (an *account*) has a shared monthly allowance, and each of its *users* has an individual allowance.
Before doing the work, the application asks this service to consume N units for a user. The service checks both
allowances, records the decision, and counts the usage only if the request is accepted.

- **Stack:** TypeScript (Node 22, Fastify, Drizzle ORM, Zod) and PostgreSQL 16. One service, one database.
- **Example application:** a small web app ("Docs App") that calls the service with an account's API key.
- **Tests:** 244 automated tests (unit, integration, concurrency). Load tests with k6.

## Contents

1. [Quick start](#quick-start) · 2. [Concepts](#concepts) · 3. [Predefined plans](#predefined-plans) ·
4. [API](#api) · 5. [How a request is decided](#how-a-request-is-decided) · 6. [Changing plans](#changing-plans) ·
7. [Retries](#retries-and-idempotency) · 8. [Concurrency design](#concurrency-design) · 9. [Data model](#data-model) ·
10. [Product assumptions](#product-assumptions) · 11. [Example client](#example-client) ·
12. [Configuration](#configuration) · 13. [Tests](#tests) · 14. [Performance](#performance) ·
15. [Design decisions](#design-decisions-and-trade-offs) · 16. [Known limitations](#known-limitations)

---

## Quick start

```bash
docker compose up --build
```

| What | Where |
|---|---|
| Metering service (API) | http://localhost:3000 (`GET /health`) |
| Example client (Docs App) | http://localhost:8080 |
| PostgreSQL | `localhost:5433` (user/password/db: `metering`) |

Startup runs the database migrations and inserts the predefined plans automatically (idempotent, safe on every start).
Data lives in the `pgdata` volume and survives restarts. The example client keeps its demo accounts and API keys in the
`clientdata` volume. `docker compose down -v` deletes both.

### Run the service locally (hot reload)

```bash
docker compose up -d db
cd service
cp .env.example .env        # DATABASE_URL already points to the published port 5433
npm install
npm run dev
```

---

## Concepts

| Concept | Meaning |
|---|---|
| **Account** | An application/company calling the service. Its plan defines limits **shared by all its users**. |
| **User** | A user of that application, registered under an account by an `externalId` (the application's own user id). Its plan defines **individual** limits. |
| **Plan** | A named set of rules (monthly allowance, maximum units per request). Assigned to an account (*account plan*) or to users (*user plan*). Several users may share one plan; usage is always counted per user. |
| **Units** | The amount consumed by an action (one resource type for the whole project). Always a positive whole number. |
| **API key** | Identifies the calling account (`X-API-Key` header). It grants access to that account's data only. |

Both plans apply **together**: giving a user a bigger allowance never increases the account's shared allowance.

### API keys

- `POST /v1/accounts` creates an account and returns its first API key **once** (format `mk_` + 43 characters). Only a
  SHA-256 hash is stored, so a lost key cannot be read back. If an account loses **all** of its keys, the operator issues a
  new one with `POST /v1/accounts/:id/api-keys` (admin token); the other keys of the account stay valid.
- Creating accounts is a bootstrap operation protected by the `X-Admin-Token` header (value of `ADMIN_TOKEN`). The
  service has no end-user login or roles, by design.
- Every other endpoint needs `X-API-Key`. A missing, malformed, unknown or revoked key gets `401 invalid_api_key`.
- The account is **always taken from the key**, never from the body or URL. Users, plans and usage of other accounts
  are invisible (`404`), so one account cannot read or consume for another.
- Key rotation: `POST /v1/account/api-keys` (new key), deploy it, then `DELETE /v1/account/api-keys/:id`. The last
  active key cannot be revoked (`409 last_active_key`) so an account cannot lock itself out.

---

## Predefined plans

Created at startup, shared by everyone, **read-only**.

| Scope | Name | Monthly allowance | Max per request |
|---|---|---:|---:|
| account | Starter *(default for new accounts)* | 10,000 | 100 |
| account | Pro | 100,000 | 1,000 |
| user | Basic *(default for new users)* | 1,000 | 20 |
| user | Premium | 10,000 | 200 |

Accounts can create, view, update and archive **their own** plans (`/v1/plans`) and assign them to the account or to
users. Rule: `maxPerRequest` cannot exceed `monthlyLimit`.

---

## API

All bodies and responses are JSON. Errors always look like `{"error":{"code","message","details?"}}`.

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /v1/accounts` | admin token | Create an account (+ first API key). Body: `{name, planId?}` |
| `POST /v1/accounts/:id/api-keys` | admin token | Recovery: issue a new key for an account that lost all its keys |
| `GET /v1/account` | key | The account and its current plan |
| `PUT /v1/account/plan` | key | Assign an account plan. Body: `{planId}` |
| `GET / POST /v1/account/api-keys`, `DELETE /v1/account/api-keys/:id` | key | List, issue, revoke keys |
| `POST /v1/users` | key | Register a user. Body: `{externalId, planId?}` |
| `GET /v1/users`, `GET /v1/users/:id` | key | List (`limit` ≤ 200, `offset`) / read users with their plan |
| `PUT /v1/users/:id/plan` | key | Change a user's plan. Body: `{planId}` |
| `DELETE /v1/users/:id` | key | Soft-delete a user (history is kept) |
| `GET /v1/plans`, `GET /v1/plans/:id` | key | Predefined plans + the account's own |
| `POST /v1/plans` | key | Create a custom plan. Body: `{name, scope, monthlyLimit, maxPerRequest}` |
| `PATCH /v1/plans/:id` | key | Update a custom plan (any of `name`, `monthlyLimit`, `maxPerRequest`) |
| `DELETE /v1/plans/:id` | key | Archive a custom plan (refused while assigned) |
| **`POST /v1/consume`** | key | **Consume units for a user.** Body: `{requestId, externalId, units}` |
| `GET /v1/usage?month=YYYY-MM&externalId=` | key | Used / remaining for the account (and one user) |
| `GET /v1/usage/users?month=&limit=&offset=` | key | Used / remaining for every user. Deleted users that used units in that month are listed last, with `deleted: true` and a `note` |
| `GET /v1/usage/history?month=&externalId=&limit=&offset=` | key | Request outcomes (accepted and rejected), newest first (`limit` ≤ 100). Each item has the same `rejection` field as `/v1/consume` |

`month` defaults to the current UTC month; use `YYYY-MM` for previous months.

### Examples

```bash
# 1. Create an account (admin) -> keep the key, it is shown once
curl -s -X POST localhost:3000/v1/accounts -H "X-Admin-Token: dev-admin-token" \
  -H "Content-Type: application/json" -d '{"name":"Docs App"}'
# {"account":{"id":"…","name":"Docs App","plan":{"name":"Starter",…}},"apiKey":{"key":"mk_…","prefix":"mk_xxxxx"}}

export KEY=mk_…   # the key from above
H='-H Content-Type:application/json'

# 2. A custom user plan, then a user on it
curl -s -X POST localhost:3000/v1/plans -H "X-API-Key: $KEY" $H \
  -d '{"name":"Trial","scope":"user","monthlyLimit":50,"maxPerRequest":20}'
curl -s -X POST localhost:3000/v1/users -H "X-API-Key: $KEY" $H \
  -d '{"externalId":"alice","planId":"<plan id>"}'

# 3. Consume 10 units for alice
curl -s -X POST localhost:3000/v1/consume -H "X-API-Key: $KEY" $H \
  -d '{"requestId":"doc-42","externalId":"alice","units":10}'
```

Accepted:

```json
{ "requestId": "doc-42", "replayed": false, "accepted": true, "units": 10, "windowStart": "2026-10-01",
  "remaining": { "account": 9990, "user": 40 }, "rejection": null }
```

Rejected (25 units against `maxPerRequest` 20; nothing is consumed):

```json
{ "requestId": "doc-43", "replayed": false, "accepted": false, "units": 25, "windowStart": "2026-10-01",
  "remaining": { "account": 9990, "user": 40 },
  "rejection": { "scope": "user", "rule": "max_per_request", "limit": 20 } }
```

`rejection.scope` is `user` or `account`; `rejection.rule` is `max_per_request` or `monthly_allowance`; `limit` is the
value of that rule. A rejection is an ordinary `200` (it is a decision, not an error). The request history uses the
**same** `rejection` object (`null` for accepted requests), next to the limits and remaining values stored with the decision.

```bash
curl -s "localhost:3000/v1/usage?externalId=alice"   -H "X-API-Key: $KEY"
# {"usage":{"period":"2026-10","account":{"limit":10000,"used":10,"remaining":9990},
#           "user":{"externalId":"alice","limit":50,"used":10,"remaining":40,…}}}
# a deleted user still counts in the account total, so it is listed (last) with a note:
curl -s "localhost:3000/v1/usage/users"              -H "X-API-Key: $KEY"
# {"users":[{"externalId":"alice","used":10,…,"deleted":false,"note":null},
#           {"externalId":"bob","used":5,"remaining":0,…,"deleted":true,"note":"This user was deleted. Their usage still counts toward the account total."}]}
curl -s "localhost:3000/v1/usage/history?limit=5"    -H "X-API-Key: $KEY"
```

### Error codes

| HTTP | Codes |
|---|---|
| 400 | `validation_error`, `invalid_month`, `invalid_plan_limits`, `plan_scope_mismatch`, `bad_request` |
| 401 | `invalid_api_key`, `invalid_admin_token` |
| 403 | `plan_read_only` |
| 404 | `user_not_found`, `plan_not_found`, `user_plan_not_found`, `account_not_found`, `api_key_not_found`, `route_not_found` |
| 409 | `idempotency_key_reused`, `user_plan_changed`, `plan_in_use`, `plan_name_already_exists`, `user_already_exists`, `last_active_key`, `account_plan_unavailable`, `user_plan_unavailable` |
| 500 | `internal_error` |

---

## How a request is decided

For `POST /v1/consume`, **all** of these must hold, checked in this order; the first that fails is reported:

1. user plan: `units ≤ maxPerRequest` → else `{scope:"user", rule:"max_per_request"}`
2. account plan: `units ≤ maxPerRequest` → else `{scope:"account", rule:"max_per_request"}`
3. user: `units ≤ remaining monthly allowance` → else `{scope:"user", rule:"monthly_allowance"}`
4. account: `units ≤ remaining monthly allowance` → else `{scope:"account", rule:"monthly_allowance"}`

If all pass, the **full** amount is added to the user's usage **and** to the account's shared usage in one transaction
(the account's usage is the sum of its users' accepted usage). A rejection consumes nothing. Examples with account
10,000/100 and user 1,000/20: 25 units → rejected by the user's per-request limit; 10 units with only 5 left on the
account → rejected by the account's monthly allowance even if the user has plenty left.

- "Month" is the **UTC calendar month in which the request is processed**. Each month starts at zero for both levels;
  previous months stay queryable.
- Rules live in `service/src/rules/` as small pure functions (`Rule`: `check(ctx) → ok | limit`) and an ordered list.
  A new rule type is one new file plus one entry in that list; nothing else changes.
- Rejections also report `remaining` as it was before the attempt, so callers can show what is left.

## Changing plans

- Changes apply to **new** requests after the update succeeds. Editing a custom plan affects every account/user
  assigned to it. A request that is already being decided at the moment of the change may still be decided with the
  previous account plan (see [Known limitations](#known-limitations)).
- Switching a plan **keeps the units already consumed**; it never grants a fresh monthly allowance.
- If an allowance is reduced below the current usage, `remaining` is **0** and consumption at that level is rejected
  until the allowance exceeds the usage again.
- Past request history is never rewritten: every recorded decision stores the plan ids and limits it was made under.
- A plan that is assigned cannot be archived (`409 plan_in_use`); predefined plans cannot be changed (`403`).

## Retries and idempotency

`requestId` is the idempotency key, scoped to the account (two accounts may reuse the same id).

- Same `requestId` + same payload → the **original decision is returned** (`"replayed": true`) and nothing is counted
  twice, including when the retries arrive in parallel.
- Same `requestId` with a different `externalId` or `units` → `409 idempotency_key_reused`.
- **A rejected request is recorded too, so retrying it returns the same rejection**, even if the plan changed in the
  meantime. To try again after e.g. an upgrade, send a **new** `requestId`.
- A replay returns the `remaining` values of the original decision, and also works after the month changed.
- If a user's plan is switched at the exact moment their request is being decided, the service restarts the decision
  (up to 3 attempts) before answering `409 user_plan_changed` (safe to retry: nothing was recorded).

## Concurrency design

Correctness first: totals stay exact under concurrent requests and concurrent plan changes, using PostgreSQL
transactions and row locks (no in-memory state, so several service processes are safe).

Inside one transaction a request: takes a per-`(account, requestId)` advisory lock → checks for a previous decision →
**share-locks** the plan rows (plan edits wait for in-flight requests; requests never wait for each other on a plan) →
locks the user row → locks the **user's counter**, then the **shared account counter** (`FOR UPDATE`) → evaluates the
rules on the locked values → increments both counters in one statement → records the decision → commits.

- Lock order is always the same (plan → user → user counter → account counter), so there are no deadlocks.
- The account counter is the contended row: all requests of one account serialise on it (see
  [Performance](#performance)). It is taken as late as possible to keep the critical section short.
- `usage_counters` has a unique index per (account, user, month); the first request of a month creates the row with
  `INSERT … ON CONFLICT DO NOTHING`, so concurrent first requests cannot create duplicates.

## Data model

`accounts` · `api_keys` (SHA-256 hash, prefix, `revoked_at`) · `plans` (`owner_account_id` NULL = predefined;
`archived_at`) · `users` (`external_id` unique per account among non-deleted users; `deleted_at`) ·
`usage_counters` (one row per account/user/month; `user_id` NULL = the shared account counter) ·
`consume_requests` (one row per decision, unique `(account_id, request_id)`, with a snapshot of the plans and limits
used and the remaining values). Migrations are plain SQL in `service/drizzle/`, applied at startup.

## Product assumptions

The brief leaves these open; this is what was chosen and applied consistently:

1. **One resource** (units). Units are positive integers; `units` and limits are capped at 2,147,483,647.
2. **Months are UTC**, decided at processing time using the service clock. Usage is never moved between months.
3. A user belongs to exactly one account; `externalId` is unique per account. Soft-deleting a user frees the id for
   re-registration (the new user starts at zero); the deleted user's past usage stays in the account total and its
   history stays visible. `GET /v1/usage/users` lists a deleted user (last, flagged `deleted`, remaining 0) in the months
   where it used units, so the listed users always add up to the account total; in other months it is not listed.
4. New accounts default to **Starter**, new users to **Basic**, unless a plan is given.
5. A plan must have `maxPerRequest ≤ monthlyLimit` (otherwise the per-request limit could never be reached).
6. Predefined plans are read-only; custom plans are private to the account that created them.
7. Rejections are recorded and idempotent (see [Retries](#retries-and-idempotency)).
8. Usage for **past months** shows limits of the plan that is assigned **now** (usage and decisions themselves are
   exact; the history rows keep the limits in force at decision time).
9. Rule priority when several rules fail: user per-request, account per-request, user monthly, account monthly.
10. Account creation is protected by a static admin token; there is no self-service sign-up, login or roles.

---

## Example client

The `client` service is a small Node web app ("Docs App") that calls the metering service **only through an account's
API key**; the document processing is simulated. Open http://localhost:8080. In the interface an account is called a
*company* and a user an *employee*.

On first start it creates a demo account in the service's database with: account plan **Demo Company** (100 units
per month, 50 per request) and users **alice** (Demo Basic: 60/month, 10 per request), **bob** (Demo Premium:
100/month, 40 per request) and **carol** (Demo Basic). It shows every decision and the remaining allowances.

Suggested walk-through (the client code is never changed; only plans change):

1. Open **An employee → alice → Process a document** with 5 units → accepted; both remaining values drop.
2. Process 15 units as alice → **rejected by the user's per-request limit** (10).
3. As **bob** process 40 + 40 units (accepted; the company has now used 85 of 100), then process 20 units as bob →
   **rejected by the shared company limit** (only 15 left) although bob still has personal allowance left.
4. In **A company** (Employees list / *Employee plans*) move alice to the Premium plan, or edit her plan's limits: the
   same 15-unit action is now accepted (the company still has exactly 15 left). Her earlier usage is kept, not reset.
5. Reload: usage, history and the demo company are still there (database and `clientdata` volume).

The client can also add more companies and employees, and rotate API keys; each company is a separate account with its
own key and isolated data.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | – (required) | PostgreSQL connection string |
| `ADMIN_TOKEN` | – (required, ≥ 8 chars) | Token for `POST /v1/accounts`. **Change it outside local use.** (compose default: `dev-admin-token`) |
| `PORT` | 3000 | HTTP port |
| `WEB_CONCURRENCY` | 1 (compose: **4**) | Number of Node processes. Migrations/seed run once in the primary process. |
| `DB_POOL_MAX` | 20 (compose: **10**) | Connections **per process**; total = `WEB_CONCURRENCY × DB_POOL_MAX` (Postgres allows 100 by default) |
| `LOG_LEVEL` | info | `silent`, `warn`, … Every request logs two lines, which costs CPU under load. |

---

## Tests

244 automated tests against a real PostgreSQL (each test file gets its own freshly migrated database):

- **unit** — rules, time/UTC month logic, API key helpers, config, retry logic
- **integration** — accounts, users, plans, consume, usage, history, schema constraints, **API key validation and
  account isolation**, month rollover (the service clock is injected), plan changes
- **concurrency** — parallel requests (never over a limit, both levels exact, parallel retries counted once, plan
  edits/switches during a burst, no deadlocks)

```bash
docker compose up -d db
cd service
npm install
TEST_DATABASE_URL=postgres://metering:metering@localhost:5433/metering npm test   # or test:unit / test:integration / test:concurrency
npm run typecheck
```

Without a local Node (PowerShell, from `service/`):

```powershell
docker run --rm --network usage-metering_default --mount "type=bind,source=$($PWD.Path),target=/app" --mount "type=volume,dst=/app/node_modules" -w /app -e TEST_DATABASE_URL=postgres://metering:metering@db:5432/metering node:22-alpine sh -lc "npm ci && npm test -- --maxWorkers=1"
```

---

## Performance

### How it was tested

- **Tool:** [k6](https://k6.io) running inside Docker Compose (profile `perf`; nothing to install). Script: `perf/load.js`.
- **Environment:** Windows laptop, Docker Desktop (8 CPUs, 3.7 GB), the service, PostgreSQL and k6 all on the same
  machine, so absolute numbers are modest and vary about ±20 % between runs. Compare runs **on the same machine**.
- **Closed model:** 50 virtual users send requests back to back; every request is a real `POST /v1/consume`.
- **Correctness is checked after every run**, not only speed: the script fails if any request is not `200`; and a
  `teardown` step asks the service for its own totals and verifies that no limit was exceeded, that each account's
  total equals the sum of its users, and (for the deterministic scenarios) the **exact** expected totals.

| Scenario | What it shows | Exact outcome that must hold |
|---|---|---|
| `distributed` | 20 accounts × 20 users, huge limits: best case | server total == accepted units |
| `hot_account` | 1 account, 50 users: every request updates the same shared counter | same |
| `hot_user` | 1 user hammered | same |
| `limit_account` | account allowance (1,000) runs out first | **exactly 1,000** accepted, 4,000 rejected |
| `limit_user` | each user's allowance (80) runs out first | **each user exactly 80**, account exactly 800 |
| `retry_storm` | 5,000 requests over only 200 distinct `requestId`s, in parallel | **exactly 200** counted, 4,800 replays |

```bash
docker compose up -d --build service
docker compose --profile perf run --rm k6 run -e SCENARIO=hot_account -e VUS=50 -e DURATION=30s /perf/load.js
# SCENARIO: distributed | hot_account | hot_user | limit_account | limit_user | retry_storm
# PowerShell: $env:LOG_LEVEL="silent"; docker compose up -d service   (quieter, faster; see below)
```

Each run writes its full metrics to `perf/results/<scenario>.json`.

### Results (final configuration: 4 workers, `LOG_LEVEL=silent`, 50 VUs, 30 s)

| Scenario | req/s | p50 | p95 | p99 | Verification |
|---|---:|---:|---:|---:|---|
| distributed | **~400** | 113 ms | 213 ms | 315 ms | totals equal (12,056 = 12,056) |
| hot_account | ~155 | 243 ms | 864 ms | 1.29 s | totals equal (4,672) |
| hot_user | ~135 | 359 ms | 485 ms | 599 ms | totals equal (4,110) |
| limit_account | – | 233 ms | 546 ms | 725 ms | **exactly 1,000 accepted**, 4,000 rejected |
| limit_user | – | 265 ms | 1.07 s | 2.48 s | **exactly 800** (80 per user), 4,200 rejected |
| retry_storm | ~1,000 | 38 ms | 77 ms | 359 ms | **exactly 200 counted**, 4,800 replays |

Zero failed requests in every run. (req/s = requests ÷ test duration; `limit_*` runs are fixed-size, so only latency
is meaningful.)

### What we learned and changed

| Step | distributed | hot_account | Finding |
|---|---:|---:|---|
| Baseline (1 process, logging on, 17 queries/request) | ~75/s | ~49/s | Throughput did **not** grow with more virtual users (1 VU ≈ 63/s, 50 VUs ≈ 66/s): something serial. `docker stats` showed the Node process at ~100 % of one core. The service was **CPU-bound**, not lock-bound. |
| Fewer queries per request (17 → 13) | ~80 → ~155/s (10 VUs) | – | Share-lock both plans in one statement; lock the counter with a single `SELECT FOR UPDATE` and insert only on the first request of a month; increment both counters in one `UPDATE`. Same locks, same order. |
| `LOG_LEVEL=silent` | ~155 → ~255/s (10 VUs) | – | Two log lines per request were expensive on Docker Desktop. Now configurable. |
| 4 processes (`WEB_CONCURRENCY=4`) | 225 → **407/s** (1.8×, controlled A/B, 3 runs each) | no change (154 → 167) | State is in PostgreSQL, so processes do not need to coordinate. |
| Account counter locked last | – | not measurable | Logical and free; kept, but its effect is inside the noise. |

**Bottlenecks understood**

- With many accounts the limit was CPU per request, fixed by doing less work per request and using more cores.
- With **one hot account** CPU stays idle (service ≈ half a core) and throughput stops at about **150 req/s per account**:
  every accepted request must update the same account row, held for ≈ 6 ms (a few round trips plus the commit). That
  is inherent to exact shared accounting; more processes do not help. Since the lock is per account, accounts do not
  slow each other down (compare `distributed`).
- Replays are much cheaper than decisions (no counter locks, no writes): ~1,000 req/s against ~400 for decisions
  on distinct accounts.
- Latency reported by k6 under 50 VUs is mostly queueing (Little's law: VUs ÷ throughput).

**Tried and rejected:** `synchronous_commit=off` gave only ~+20 % and can lose the last moments of accepted decisions
after a crash; for a quota service that is the wrong trade, so durability stays at the default.

**Trade-off of the cluster:** with 4 processes the p95 of the hot-account case grows (about 500 → 860 ms, same
throughput) because more requests wait on the same row; every other scenario improves. Use `WEB_CONCURRENCY=1` or `2`
if a single account must have tight tail latency.

---

## Design decisions and trade-offs

- **Database as the single source of truth** (counters, locks, history). Simple and safe for correctness; the price is
  the per-account ceiling above. Horizontal scaling of the service needs no extra infrastructure.
- **Pessimistic row locks instead of optimistic retries:** contended counters would otherwise retry a lot under bursts.
- **Decision history is an immutable log with a snapshot of the limits.** It answers "why was this rejected?" even
  after plans change, and makes retries exact.
- **Plans as shared rows:** editing a plan takes effect for every user on it immediately, with no per-user copy.
- **Layers:** `routes` (HTTP + validation) → `services` (transactions, business flow) → `repositories` (SQL) and a pure
  `rules` module (decisions). The rules module has no I/O, which is why it is easy to test and extend.
- **Clock injection** (`Clock` in `lib/time.ts`) so month boundaries are tested end to end.

## Known limitations

- **Per-account throughput is capped** (~150 requests/s on the test machine) because one shared counter must be updated
  exactly. A single-statement conditional update, skipping the account lock for rejections already decided by a user
  rule, or sharded counters could raise it; they were left out to keep the rules readable and the core reliable.
- One PostgreSQL instance (no replication/failover); the compose setup is for development and evaluation, not hardened
  (static admin token, no TLS, no rate limiting on the API).
- `consume_requests` grows without bound (no retention or partitioning); an API-key lookup is one query per request
  (no cache, so revocation is immediate).
- The month is decided with the service's clock; several processes on machines with skewed clocks could disagree
  around midnight UTC on the first of a month.
- Limits shown for past months are those of the plan assigned now (the exact decision-time limits are in the history).
- A rejected `requestId` is final; callers must use a new id to try again (documented above).
- Performance numbers come from one development laptop and are indicative, not a capacity guarantee.

- **Account plan switch during an in-flight request.** `consume` reads the account's plan without locking the account
  row, then share-locks the plan. If `PUT /v1/account/plan` commits in that short window, that one request is decided
  with the previous plan and recorded just after the switch. Requests that start after the update succeeds always use
  the new plan. The user's plan does not have this gap (it is re-checked after the user row is locked and the request is
  retried). The fix would be to share-lock the account row while reading its plan, at the cost of extra contention on
  the hottest row; it was left out to keep the per-account throughput measured in [Performance](#performance).
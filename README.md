# Usage Metering and Quota Service

> Work in progress. Full README (API, assumptions, design, limitations) comes in phase 8.

## Run (Docker)

```bash
docker compose up --build
curl http://localhost:3000/health
```

## Run service locally (hot reload)

```bash
docker compose up -d db
cd service
npm install
DATABASE_URL=postgres://metering:metering@localhost:5433/metering ADMIN_TOKEN=dev-admin-token npm run dev
```

Migrations (`service/drizzle/*.sql`) and predefined plans are applied automatically on startup.

## Predefined plans

| Plan | Scope | Monthly | Per request |
|---|---|---|---|
| Starter | account | 10,000 | 100 |
| Pro | account | 100,000 | 1,000 |
| Basic | user | 1,000 | 20 |
| Premium | user | 10,000 | 200 |

## API (current)

Auth: `X-Admin-Token` for account creation, `X-API-Key` for everything else (checked before the body is parsed).
Errors: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/accounts` | (operator) create account, returns API key once |
| GET | `/v1/account` | calling account + its plan |
| PUT | `/v1/account/plan` | assign an account plan |
| GET / POST | `/v1/account/api-keys` | list keys (no secrets) / issue an additional key |
| DELETE | `/v1/account/api-keys/:id` | revoke a key (idempotent; the last active key cannot be revoked) |
| POST / GET | `/v1/users` | register user / list users (`limit`, `offset`) |
| GET / DELETE | `/v1/users/:id` | read / soft-delete (the externalId can be registered again) |
| PUT | `/v1/users/:id/plan` | assign a user plan |
| GET / POST | `/v1/plans` | list visible plans / create a custom plan |
| GET / PATCH / DELETE | `/v1/plans/:id` | read / edit / archive (predefined plans: 403 `plan_read_only`) |
| POST | `/v1/consume` | `{ requestId, externalId, units }` → decision (`replayed: true` on an idempotent retry) |
| GET | `/v1/usage` | account usage for a month (+ one user with `?externalId=`) |
| GET | `/v1/usage/users` | every user's used/remaining for a month (paginated) |
| GET | `/v1/usage/history` | request outcomes for a month (`limit`, `offset`, `externalId`, returns `total`) |

Code style: `npm run format` / `npm run format:check` (Prettier).

## Example client (Docs App)

A deliberately small web app (plain HTML/CSS/JS + a ~100-line Node server, no dependencies) that
simulates a company calling the service on behalf of its users.

```bash
docker compose up --build
# open http://localhost:8080
```

On startup the client creates a demo account (via the operator token), creates its own plans
(account: 100/month, 50 per request; users: Demo Basic 60/10, Demo Premium 100/40) and three users
(alice, bob, carol). The account's API key stays on the client's server; the browser never sees it.

The page shows the shared and per-user allowances, the decision for each "Process" click
(accepted, or which rule of which plan — user or account — rejected it) and the recent request history.
The "Try this" list on the page walks through: an accepted action, a rejection by a **user** limit,
switching alice to another plan (no client code change), and a rejection by the shared **account** limit.
"New demo account" starts over with a clean slate.

Run it without Docker: start the service (see above), then
`cd client && SERVICE_URL=http://localhost:3000 ADMIN_TOKEN=dev-admin-token npm start`.
# Usage Metering and Quota Service

> Work in progress. Full README (API, assumptions, design, limitations) comes in phase 8.

## Run (Docker)

```bash
docker compose up --build
curl http://localhost:3000/health
```

## Run service locally (hot reload)

```bash
docker compose up -d db
cd service
npm install
DATABASE_URL=postgres://metering:metering@localhost:5433/metering ADMIN_TOKEN=dev-admin-token npm run dev
```

Migrations (`service/drizzle/*.sql`) and predefined plans are applied automatically on startup.

## Predefined plans

| Plan | Scope | Monthly | Per request |
|---|---|---|---|
| Starter | account | 10,000 | 100 |
| Pro | account | 100,000 | 1,000 |
| Basic | user | 1,000 | 20 |
| Premium | user | 10,000 | 200 |

## API (current)

Auth: `X-Admin-Token` for account creation, `X-API-Key` for everything else (checked before the body is parsed).
Errors: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/accounts` | (operator) create account, returns API key once |
| GET | `/v1/account` | calling account + its plan |
| PUT | `/v1/account/plan` | assign an account plan |
| GET / POST | `/v1/account/api-keys` | list keys (no secrets) / issue an additional key |
| DELETE | `/v1/account/api-keys/:id` | revoke a key (idempotent; the last active key cannot be revoked) |
| POST / GET | `/v1/users` | register user / list users (`limit`, `offset`) |
| GET / DELETE | `/v1/users/:id` | read / soft-delete (the externalId can be registered again) |
| PUT | `/v1/users/:id/plan` | assign a user plan |
| GET / POST | `/v1/plans` | list visible plans / create a custom plan |
| GET / PATCH / DELETE | `/v1/plans/:id` | read / edit / archive (predefined plans: 403 `plan_read_only`) |
| POST | `/v1/consume` | `{ requestId, externalId, units }` → decision (`replayed: true` on an idempotent retry) |
| GET | `/v1/usage` | account usage for a month (+ one user with `?externalId=`) |
| GET | `/v1/usage/users` | every user's used/remaining for a month (paginated) |
| GET | `/v1/usage/history` | request outcomes for a month (`limit`, `offset`, `externalId`, returns `total`) |

Code style: `npm run format` / `npm run format:check` (Prettier).

## Example client (Docs App)

A deliberately small web app (plain HTML/CSS/JS + a ~150-line Node server, no dependencies) that
simulates a company calling the service on behalf of its users.

```bash
docker compose up --build
# open http://localhost:8080
```

On startup the client creates a demo account (via the operator token), gives it a small custom plan
(100/month, 50 per request), two custom user plans (Demo Basic 60/10, Demo Premium 100/40) and three users
(alice, bob, carol). The account's API key stays on the client's server; the browser never sees it.

The home page has three cards, one per actor:

| Card | Who | What it does | API used |
|---|---|---|---|
| System | The operator (admin token) | Lists every company with its plan, plans, users and usage; adds a company; opens one | `POST /v1/accounts`, `GET /v1/account`, `/users` |
| Company | A company (its API key) | **Overview**: the company's own plan (change it). **Plans**: create / edit / archive company plans and employee plans. **Employees**: add, change plan, details, delete. **API keys**: list, create, rotate, revoke, 401 demo. **Usage**: month picker, per-employee usage, history | `/v1/account`, `PUT /v1/account/plan`, `/v1/plans`, `/v1/users`, `PUT /v1/users/:id/plan`, `/v1/account/api-keys`, `/v1/usage`, `/usage/users`, `/usage/history` |
| Employee | One employee (no credentials; the company's backend calls the service) | Limits of the employee and the company, process a document, own request history | `POST /v1/consume`, `GET /v1/usage`, `/usage/history` |

Every call the page makes appears in the **call log** at the bottom. Suggested walkthrough: open Company → Plans and create a
company plan, apply it in Overview; create an employee plan and assign it in Employees; open the employee and process a
document (accepted, then one above the per-request limit to see a rejection). Usage never resets within a month, so a new company is the clean slate.

**Where is the data?** Companies, users, plans, usage and history are stored by the service in PostgreSQL (volume `pgdata`),
so adding a company never removes another one and everything survives `docker compose down` / `up`.
An API key is shown only once, so this *demo client* keeps the keys of the companies it created in `/data/companies.json`
(volume `clientdata`) to let you switch between them. A real application would simply hold its own key.
`docker compose down -v` wipes both volumes. If only `clientdata` is wiped, the old companies stay in the database but
this client no longer has their keys.

Run it without Docker: start the service (see above), then
`cd client && SERVICE_URL=http://localhost:3000 ADMIN_TOKEN=dev-admin-token npm start`.

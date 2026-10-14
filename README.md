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
DATABASE_URL=postgres://metering:metering@localhost:5432/metering ADMIN_TOKEN=dev-admin-token npm run dev
```

Migrations (`service/drizzle/*.sql`) and predefined plans are applied automatically on startup.

## Predefined plans

| Plan | Scope | Monthly | Per request |
|---|---|---|---|
| Starter | account | 10,000 | 100 |
| Pro | account | 100,000 | 1,000 |
| Basic | user | 1,000 | 20 |
| Premium | user | 10,000 | 200 |

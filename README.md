# StockSync

Smart inventory management for a two-store electronics retailer, built as a
stateful cloud-native application for ECE1779 (Introduction to Cloud Computing).

> The full final report will replace this README. Current status: **Day 2:
> inventory API (sales, restocks, adjustments, transfers, audit) with automated tests.**

## Quick start (local, Docker Compose)

Requirements: Docker Desktop, Node.js 24 (`nvm use`), git.

```bash
# 1. One-time: create local secrets (git-ignored)
openssl rand -hex 24 > secrets/db_password.txt
openssl rand -hex 32 > secrets/jwt_secret.txt
cp .env.example .env

# 2. Build and start PostgreSQL 18 + the API
docker compose up --build -d
docker compose ps            # db and api should both be "healthy"

# 3. Verify
./tests/smoke-day1.sh                 # health, login, roles
node tests/concurrency-test.mjs       # 20 buyers race for the last unit

# 4. Automated test suite (separate stocksync_test database)
cd backend && npm ci && npm test
```

See [docs/testing.md](docs/testing.md) for what the tests prove.

Demo accounts (password `StockSync!2026`):

| Email | Role | Store |
|---|---|---|
| admin@stocksync.dev | admin | (all) |
| manager.dt@stocksync.dev | manager | Downtown |
| staff.dt@stocksync.dev | staff | Downtown |
| manager.ny@stocksync.dev | manager | North York |
| staff.ny@stocksync.dev | staff | North York |

## Repository layout

```
backend/     Express API (Node.js 24) and its Dockerfile
database/    init/ schema + seed (run on first start), checks.sql integrity checks
frontend/    React app (Day 3)
k8s/         Kubernetes manifests (Day 4+)
tests/       smoke, concurrency and load tests
docs/        architecture and evidence
compose.yaml local multi-container setup
```

## API

All `/api` routes except login require `Authorization: Bearer <token>`.
Errors are returned as `{ "error": { "code", "message", "details" } }`.

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | /health | public | liveness probe (process alive) |
| GET | /ready | public | readiness probe (database reachable) |
| POST | /api/auth/login | public, rate-limited | email + password → JWT |
| GET | /api/auth/me | any role | current user |
| GET | /api/stores | any role | list stores |
| GET | /api/users | admin | list accounts |
| GET | /api/products | any role | catalogue with per-store quantities (`?category=&q=`) |
| GET | /api/products/:id | any role | one product |
| GET | /api/stock | any role | stock rows (`?storeId=&productId=&category=&q=&lowOnly=true`) |
| GET | /api/low-stock | any role | at/below reorder threshold (`?storeId=`) |
| POST | /api/sales | any role, own store | `{storeId, productId, quantity, note?}` → 201, or 409 `OUT_OF_STOCK` |
| POST | /api/restocks | any role, own store | `{storeId, productId, quantity, note?}` |
| POST | /api/adjustments | manager/admin, own store | `{storeId, productId, change, reason}` (change may be negative) |
| GET | /api/transfers | any role (own store; admin all) | `?status=&storeId=` |
| GET | /api/transfers/:id | involved stores, admin | one transfer |
| POST | /api/transfers | either store involved, admin | `{productId, fromStoreId, toStoreId, quantity, note?}` |
| POST | /api/transfers/:id/dispatch | source-store manager, admin | requested → in_transit (stock leaves source) |
| POST | /api/transfers/:id/receive | destination store, admin | in_transit → received (stock arrives, exactly once) |
| POST | /api/transfers/:id/cancel | manager of either store, admin | → cancelled (in-transit units returned to source) |
| GET | /api/movements | own store (admin all) | audit history, newest first (`?storeId=&productId=&userId=&type=&transferId=&limit=&before=`) |

# StockSync

![CI](https://github.com/sohaib629/ccproject/actions/workflows/ci.yml/badge.svg)

Smart inventory management for a two-store electronics retailer, built as a
stateful cloud-native application for ECE1779 (Introduction to Cloud Computing).

> The full final report will replace this README. Current status: **Day 3:
> React frontend, admin System page, and CI on every pull request.**

## Quick start (local, Docker Compose)

Requirements: Docker Desktop, Node.js 24 (`nvm use`), git.

```bash
# 1. One-time: create local secrets (git-ignored)
openssl rand -hex 24 > secrets/db_password.txt
openssl rand -hex 32 > secrets/jwt_secret.txt
cp .env.example .env

# 2. Build and start PostgreSQL 18, the API and the frontend
docker compose up --build -d
docker compose ps            # db, api and frontend should all be "healthy"
open http://localhost:8080   # the web app

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
frontend/    React app (Vite) and its nginx Dockerfile
k8s/         Kubernetes manifests (Day 4+)
tests/       smoke, concurrency and load tests
docs/        architecture and evidence
compose.yaml local multi-container setup
.github/     CI workflow: tests + builds on every pull request
```

## Frontend

React 19 single-page app built with Vite, served by nginx (non-root, port 8080).
It always calls the API at the relative path `/api`, so one build works everywhere:
Vite's dev server proxies `/api` locally, nginx proxies it in Docker Compose, and the
Kubernetes Gateway routes it in the cloud.

| Page | Who | What |
|---|---|---|
| Inventory | all | both stores side by side; low/out highlighted; Sell, Restock (own store), Adjust (manager/admin) |
| Transfers | all | request; Dispatch (source manager), Receive (destination), Cancel (managers) |
| Low stock | all | items at or below reorder threshold |
| History | all (own store; admin all) | append-only audit log, filters, paging |
| System | admin | live infrastructure view: API replica, replicas seen, Kubernetes pod/node, PostgreSQL version/latency/size/pool, live integrity checks, auth settings (no secret values), permissions matrix, route list |

Frontend development with hot reload: `cd frontend && npm ci && npm run dev` → http://localhost:5173
(needs the API on localhost:3000, e.g. `docker compose up -d db api`).

Buttons are shown according to role, but **all rules are enforced by the API**; hiding
a button is only a convenience. Tradeoff: the login token is kept in `sessionStorage`
(cleared when the tab closes). An httpOnly cookie would resist XSS better but would need
CSRF protection; the strict Content-Security-Policy set by nginx reduces the XSS risk.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and push to `main`:
1. **Backend tests**: the full suite against a fresh PostgreSQL 18 service container.
2. **Frontend build**: `npm ci && npm run build`.
3. **Docker images**: both images built for `linux/amd64` (DigitalOcean's architecture).

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
| GET | /api/system | admin | infrastructure status for the System page (no secret values) |

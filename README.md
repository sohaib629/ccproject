# StockSync

Smart inventory management for a two-store electronics retailer, built as a
stateful cloud-native application for ECE1779 (Introduction to Cloud Computing).

> The full final report will replace this README. Current status: **Day 1:
> database, API foundation and authentication.**

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
./tests/smoke-day1.sh
```

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

## API so far

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | /health | public | liveness probe (process alive) |
| GET | /ready | public | readiness probe (database reachable) |
| POST | /api/auth/login | public, rate-limited | email + password → JWT |
| GET | /api/auth/me | any role | current user |
| GET | /api/stores | any role | list stores |
| GET | /api/users | admin | list accounts |

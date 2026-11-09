# Testing and evidence

## How to run

| What | Command | Needs |
|---|---|---|
| Automated test suite (38 tests) | `cd backend && npm test` | `docker compose up -d db`, Node 24, `npm ci` once |
| Day 1 smoke test | `./tests/smoke-day1.sh` | full stack running |
| Last-unit race against any deployment | `node tests/concurrency-test.mjs` (`API_URL=...` to target minikube/DOKS) | full stack running |
| Database integrity checks | `docker compose exec -T db psql -U stocksync -d stocksync < database/checks.sql` | db running |

The automated suite uses a **separate database, `stocksync_test`**, in the same
PostgreSQL server. It is dropped and re-seeded from `database/init/*.sql` before
each test file, so tests always start from a known state and never touch
development data. (The harness refuses to run against a database whose name does
not end in `_test`.)

## What the suite proves

| Area | Tests |
|---|---|
| First workflow | 5 MacBooks → sell 1 → 4, with a matching `sale` audit row |
| Overselling | 20 simultaneous buyers for 1 unit → exactly 1 success, 19 × `409 OUT_OF_STOCK`, quantity 0, one audit row; 30 buyers for 5 units → exactly 5 |
| Atomicity | If the audit insert fails, the stock decrease is rolled back |
| Transfers | full lifecycle; dispatch only by source manager; receive only by destination; double dispatch/receive rejected; insufficient source stock leaves the transfer `requested`; cancelling in-transit returns units (`transfer_return`) |
| Transfer races | 10 simultaneous receives → units arrive once; 10 simultaneous dispatches → units leave once; receive vs cancel → exactly one wins, no unit lost or duplicated |
| Access control | store scoping (403), role checks (403), validation (400), login required (401) |
| Integrity | after every test file: stock = sum of audit history; no negative stock; every received transfer has exactly one `transfer_in` |

## Evidence: the race test detects real overselling

To confirm the concurrency test is meaningful, the atomic conditional update in
`backend/src/services/inventory.js` was temporarily replaced with a naive
"read quantity, check in JavaScript, write new quantity" implementation:

| Scenario | Naive read-then-write | Atomic conditional `UPDATE ... WHERE quantity >= n` |
|---|---|---|
| 20 buyers, 1 unit | **8 sales succeeded** (oversold by 7) | 1 sale succeeded |
| 30 buyers, 5 units | **30 sales succeeded** (oversold by 25) | 5 sales succeeded |
| Stock vs audit history | mismatched | always equal |

Why the atomic version works: `UPDATE stock SET quantity = quantity - $n WHERE ...
AND quantity >= $n` locks the row. Concurrent transactions queue on that lock, and
under PostgreSQL's READ COMMITTED isolation each waiting update re-evaluates the
`WHERE` condition against the latest committed row before applying. Once the
quantity reaches 0, the condition is false and zero rows are updated → `409
OUT_OF_STOCK`. No application-level locks are involved, so the guarantee holds
across any number of API replicas.

Transfers use `SELECT ... FOR UPDATE` on the transfer row before checking its
status, so concurrent dispatch/receive/cancel requests for the same transfer are
serialized and only the first valid transition succeeds.

## Known limitation

A client that times out and retries a sale could record it twice (the server
cannot tell a retry from a new sale). Idempotency keys would solve this; they are
out of scope for this project.

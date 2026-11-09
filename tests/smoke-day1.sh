#!/usr/bin/env bash
# Day 1 smoke test: health, readiness, login, JWT and role-based access.
# Usage:  ./tests/smoke-day1.sh                (defaults to http://localhost:3000)
#         API_URL=https://your-domain ./tests/smoke-day1.sh
set -uo pipefail

API="${API_URL:-http://localhost:3000}"
PASSWORD="${DEMO_PASSWORD:-StockSync!2026}"
pass=0; fail=0

check() { # check <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; pass=$((pass+1));
  else echo "  FAIL  $1 (expected $2, got $3)"; fail=$((fail+1)); fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
login() {
  curl -s -H 'content-type: application/json' \
       -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" "$API/api/auth/login" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).token||"")}catch{console.log("")}})'
}

echo "StockSync Day 1 smoke test against $API"
check "GET /health is 200"                       200 "$(status "$API/health")"
check "GET /ready is 200 (database reachable)"   200 "$(status "$API/ready")"
check "no token -> 401"                          401 "$(status "$API/api/stores")"
check "wrong password -> 401"                    401 "$(status -H 'content-type: application/json' -d '{"email":"admin@stocksync.dev","password":"wrong"}' "$API/api/auth/login")"
check "invalid body -> 400"                      400 "$(status -H 'content-type: application/json' -d '{"email":"x"}' "$API/api/auth/login")"

ADMIN=$(login admin@stocksync.dev)
STAFF=$(login staff.dt@stocksync.dev)
check "admin login returns a token"  yes "$([[ -n "$ADMIN" ]] && echo yes || echo no)"
check "staff login returns a token"  yes "$([[ -n "$STAFF" ]] && echo yes || echo no)"

check "staff GET /api/auth/me -> 200"            200 "$(status -H "authorization: Bearer $STAFF" "$API/api/auth/me")"
check "staff GET /api/stores -> 200"             200 "$(status -H "authorization: Bearer $STAFF" "$API/api/stores")"
check "staff GET /api/users -> 403 (admin only)" 403 "$(status -H "authorization: Bearer $STAFF" "$API/api/users")"
check "admin GET /api/users -> 200"              200 "$(status -H "authorization: Bearer $ADMIN" "$API/api/users")"
check "tampered token -> 401"                    401 "$(status -H "authorization: Bearer ${STAFF}x" "$API/api/users")"

echo "Result: $pass passed, $fail failed"
[[ $fail -eq 0 ]]

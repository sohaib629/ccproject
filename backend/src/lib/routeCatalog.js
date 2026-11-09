// Human-readable list of every API endpoint, shown on the System page.
// Kept next to the code and checked by test/system.test.js, which calls every
// route listed here and fails if one does not exist.
module.exports = Object.freeze([
  { method: "GET",  path: "/health",                     access: "public",                         purpose: "Liveness probe: process is alive" },
  { method: "GET",  path: "/ready",                      access: "public",                         purpose: "Readiness probe: database reachable" },
  { method: "POST", path: "/api/auth/login",             access: "public (rate-limited)",          purpose: "Email + password → JWT" },
  { method: "GET",  path: "/api/auth/me",                access: "any role",                       purpose: "Current user" },
  { method: "GET",  path: "/api/stores",                 access: "any role",                       purpose: "List stores" },
  { method: "GET",  path: "/api/users",                  access: "admin",                          purpose: "List accounts" },
  { method: "GET",  path: "/api/products",               access: "any role",                       purpose: "Catalogue with per-store quantities" },
  { method: "GET",  path: "/api/products/:id",           access: "any role",                       purpose: "One product" },
  { method: "GET",  path: "/api/stock",                  access: "any role",                       purpose: "Stock rows with filters" },
  { method: "GET",  path: "/api/low-stock",              access: "any role",                       purpose: "At or below reorder threshold" },
  { method: "POST", path: "/api/sales",                  access: "any role, own store",            purpose: "Atomic sale (409 OUT_OF_STOCK)" },
  { method: "POST", path: "/api/restocks",               access: "any role, own store",            purpose: "Add units" },
  { method: "POST", path: "/api/adjustments",            access: "manager/admin, own store",       purpose: "Correction with mandatory reason" },
  { method: "GET",  path: "/api/transfers",              access: "own store (admin: all)",         purpose: "List transfers" },
  { method: "GET",  path: "/api/transfers/:id",          access: "involved stores, admin",         purpose: "One transfer" },
  { method: "POST", path: "/api/transfers",              access: "either store involved, admin",   purpose: "Request a transfer" },
  { method: "POST", path: "/api/transfers/:id/dispatch", access: "source-store manager, admin",    purpose: "requested → in_transit" },
  { method: "POST", path: "/api/transfers/:id/receive",  access: "destination store, admin",       purpose: "in_transit → received (exactly once)" },
  { method: "POST", path: "/api/transfers/:id/cancel",   access: "manager of either store, admin", purpose: "→ cancelled (in-transit units returned)" },
  { method: "GET",  path: "/api/movements",              access: "own store (admin: all)",         purpose: "Audit history, newest first" },
  { method: "GET",  path: "/api/system",                 access: "admin",                          purpose: "This page: infrastructure status" },
]);

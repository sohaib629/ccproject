// Login rate limiting: only wrong credentials count towards the limit.
// (Found by the Day 6 load test: before this, server errors and the 429s
// themselves were counted, so an overloaded pod locked real users out.)
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers/setup");

let server, api;

before(async () => {
  await h.resetDatabase();
  server = await h.startServer();
  api = h.apiClient(server.baseUrl);
});

after(async () => {
  await server.close();
});

const attempt = (email, password) => api.post("/api/auth/login", { body: { email, password } });

test("successful logins and malformed requests do not count towards the limit", async () => {
  for (let i = 0; i < 12; i++) {
    assert.equal((await attempt("staff.dt@stocksync.dev", "StockSync!2026")).status, 200);
  }
  for (let i = 0; i < 12; i++) {
    assert.equal((await attempt("not-an-email", "x")).status, 400);
  }
  // Still allowed: none of the 24 requests above was a wrong password.
  assert.equal((await attempt("staff.dt@stocksync.dev", "wrong-password")).status, 401);
});

test("the 10th wrong password is the last one allowed; then 429 for everyone from that address", async () => {
  // One wrong attempt was made in the previous test, so 9 more reach the limit.
  for (let i = 0; i < 9; i++) {
    assert.equal((await attempt("staff.dt@stocksync.dev", "wrong-password")).status, 401);
  }
  const blocked = await attempt("staff.dt@stocksync.dev", "wrong-password");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, "TOO_MANY_ATTEMPTS");
  // Blocked requests do not extend the lockout by counting themselves; the
  // correct password is blocked too until the window ends (by design).
  assert.equal((await attempt("staff.dt@stocksync.dev", "StockSync!2026")).status, 429);
});

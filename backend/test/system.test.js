// Admin-only System endpoint: access control, content, and no secret leakage.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers/setup");
const routeCatalog = require("../src/lib/routeCatalog");

let server, api, admin, staff, manager;

before(async () => {
  await h.resetDatabase();
  server = await h.startServer();
  api = h.apiClient(server.baseUrl);
  [admin, staff, manager] = await Promise.all([
    api.login("admin@stocksync.dev"),
    api.login("staff.dt@stocksync.dev"),
    api.login("manager.dt@stocksync.dev"),
  ]);
});

after(async () => {
  await server.close();
});

test("only admins can open the System page", async () => {
  assert.equal((await api.get("/api/system")).status, 401);
  assert.equal((await api.get("/api/system", { token: staff })).status, 403);
  assert.equal((await api.get("/api/system", { token: manager })).status, 403);
  assert.equal((await api.get("/api/system", { token: admin })).status, 200);
});

test("reports the API instance, database, integrity, auth and routes", async () => {
  const { body } = await api.get("/api/system", { token: admin });
  assert.ok(body.api.instance);
  assert.match(body.api.node, /^v\d+/);
  assert.match(body.database.version, /^\d+/);
  assert.ok(body.database.latencyMs >= 0);
  assert.equal(body.database.tables.find((t) => t.table === "stores").rows, 3);
  assert.ok(body.database.pool.max > 0);
  assert.equal(body.integrity.length, 3);
  assert.ok(body.integrity.every((c) => c.ok), "fresh seed data passes every integrity check");
  assert.equal(body.auth.algorithm, "HS256");
  assert.equal(body.auth.yourToken.role, "admin");
  assert.ok(Date.parse(body.auth.yourToken.expiresAt) > Date.now());
  assert.equal(body.routes.length, routeCatalog.length);
});

test("never returns secret values", async () => {
  const res = await fetch(`${server.baseUrl}/api/system`, { headers: { authorization: `Bearer ${admin}` } });
  const raw = await res.text();
  assert.ok(!raw.includes(h.config.jwt.secret), "JWT signing key must not appear");
  assert.ok(!raw.includes(h.config.db.password), "database password must not appear");
  assert.ok(!raw.includes("$2b$"), "no bcrypt hashes");
});

test("every route in the catalogue actually exists (no 404)", async () => {
  for (const r of routeCatalog) {
    const path = r.path.replace(":id", "1");
    const res = await fetch(server.baseUrl + path, {
      method: r.method,
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: r.method === "POST" ? "{}" : undefined,
    });
    const body = res.status === 404 ? await res.json() : null;
    assert.ok(
      res.status !== 404 || body?.error?.message !== "Route not found",
      `${r.method} ${r.path} is listed but not implemented`,
    );
  }
});

// Distribution centre (migration 001), catalogue of 100 products (migration 002),
// the migration runner itself, and the build information in /api/health.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const h = require("./helpers/setup");
const { migrate, migrationFiles } = require("../src/migrate");

let server, api, tok, WH, DT, NY;

before(async () => {
  await h.resetDatabase();
  server = await h.startServer();
  api = h.apiClient(server.baseUrl);
  tok = {};
  for (const [k, email] of Object.entries({
    staffDT: "staff.dt@stocksync.dev", staffNY: "staff.ny@stocksync.dev",
    managerWH: "manager.wh@stocksync.dev", staffWH: "staff.wh@stocksync.dev", admin: "admin@stocksync.dev",
  })) tok[k] = await api.login(email);
  WH = (await h.ids("WH", "LAP-MBA13-M4")).storeId;
  DT = (await h.ids("DT", "LAP-MBA13-M4")).storeId;
  NY = (await h.ids("NY", "LAP-MBA13-M4")).storeId;
});

after(async () => {
  await server.close();
});

describe("locations and catalogue", () => {
  test("three locations: two stores and one distribution centre", async () => {
    const { stores } = (await api.get("/api/stores", { token: tok.staffDT })).body;
    assert.deepEqual(stores.map((s) => [s.code, s.kind]), [["WH", "warehouse"], ["DT", "store"], ["NY", "store"]]);
  });

  test("the catalogue has 100 products, each stocked at all three locations", async () => {
    const { products } = (await api.get("/api/products", { token: tok.staffDT })).body;
    assert.equal(products.length, 100);
    assert.ok(products.every((p) => Object.keys(p.stock).sort().join() === "DT,NY,WH"));
  });

  test("warehouse users log in with their location in the profile", async () => {
    const res = await api.post("/api/auth/login", { body: { email: "manager.wh@stocksync.dev", password: "StockSync!2026" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.store.code, "WH");
    assert.equal(res.body.user.store.kind, "warehouse");
  });
});

describe("replenishment: distribution centre -> store", () => {
  test("store requests, warehouse manager dispatches, store receives: units move exactly once", async () => {
    const wh0 = await h.quantity("WH", "LAP-MBA13-M4");
    const dt0 = await h.quantity("DT", "LAP-MBA13-M4");
    const { productId } = await h.ids("WH", "LAP-MBA13-M4");

    const req = await api.post("/api/transfers", {
      token: tok.staffDT, body: { productId, fromStoreId: WH, toStoreId: DT, quantity: 6, note: "Replenishment" },
    });
    assert.equal(req.status, 201);
    const id = req.body.transfer.id;

    // Store staff cannot dispatch from the distribution centre.
    assert.equal((await api.post(`/api/transfers/${id}/dispatch`, { token: tok.staffDT })).status, 403);

    assert.equal((await api.post(`/api/transfers/${id}/dispatch`, { token: tok.managerWH })).status, 200);
    assert.equal(await h.quantity("WH", "LAP-MBA13-M4"), wh0 - 6);
    assert.equal((await api.post(`/api/transfers/${id}/receive`, { token: tok.staffDT })).status, 200);
    assert.equal(await h.quantity("DT", "LAP-MBA13-M4"), dt0 + 6);
  });

  test("two stores racing for the warehouse's last units: only one dispatch succeeds", async () => {
    const { productId } = await h.ids("WH", "CON-XSX-1TB");
    // Leave exactly 4 units at the distribution centre.
    const have = await h.quantity("WH", "CON-XSX-1TB");
    const adj = await api.post("/api/adjustments", {
      token: tok.managerWH, body: { storeId: WH, productId, change: 4 - have, reason: "Cycle count" },
    });
    assert.equal(adj.status, 201);

    const toDT = (await api.post("/api/transfers", { token: tok.staffDT, body: { productId, fromStoreId: WH, toStoreId: DT, quantity: 4 } })).body.transfer;
    const toNY = (await api.post("/api/transfers", { token: tok.staffNY, body: { productId, fromStoreId: WH, toStoreId: NY, quantity: 4 } })).body.transfer;

    const results = await Promise.all([
      api.post(`/api/transfers/${toDT.id}/dispatch`, { token: tok.managerWH }),
      api.post(`/api/transfers/${toNY.id}/dispatch`, { token: tok.admin }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(results.find((r) => r.status === 409).body.error.code, "INSUFFICIENT_STOCK");
    assert.equal(await h.quantity("WH", "CON-XSX-1TB"), 0, "never negative");
  });

  test("low stock suggests a replenishment quantity, limited by the distribution centre", async () => {
    const { lowStock } = (await api.get("/api/low-stock", { token: tok.staffDT })).body;
    const storeRows = lowStock.filter((r) => r.storeKind === "store");
    assert.ok(storeRows.length > 0);
    for (const r of storeRows) {
      const expected = Math.max(0, Math.min(2 * r.reorderThreshold - r.quantity, r.warehouseQuantity));
      assert.equal(r.suggestedQuantity, expected, r.sku);
      assert.equal(r.warehouseId, WH);
    }
    assert.ok(lowStock.filter((r) => r.storeKind === "warehouse").every((r) => r.suggestedQuantity === null));
  });

  test("warehouse staff can receive supplier deliveries but not sell", async () => {
    const { productId } = await h.ids("WH", "AUD-APP2-USB-C");
    assert.equal((await api.post("/api/restocks", { token: tok.staffWH, body: { storeId: WH, productId, quantity: 10 } })).status, 201);
    assert.equal((await api.post("/api/sales", { token: tok.staffWH, body: { storeId: WH, productId, quantity: 1 } })).status, 409);
  });
});

describe("migrations", () => {
  test("every migration is recorded once, with its checksum", async () => {
    const rows = await h.sql("SELECT version, checksum FROM schema_migrations ORDER BY version");
    const files = migrationFiles();
    assert.deepEqual(rows.map((r) => r.version), files.map((f) => f.version));
    assert.deepEqual(rows.map((r) => r.checksum), files.map((f) => f.checksum));
  });

  test("running the migrations again changes nothing (idempotent)", async () => {
    const client = new Client({
      host: h.config.db.host, port: h.config.db.port, user: h.config.db.user,
      password: h.config.db.password, database: h.config.db.database,
    });
    await client.connect();
    try {
      const result = await migrate(client);
      assert.deepEqual(result.applied, []);
      assert.equal(result.alreadyApplied, migrationFiles().length);
    } finally {
      await client.end();
    }
  });
});

test("health reports the running build (commit is 'dev' outside a deployment)", async () => {
  const res = await api.get("/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ready");
  assert.equal(res.body.commit, "dev");
  assert.ok(res.body.version);
});

test("integrity holds after replenishment and races", async () => {
  assert.deepEqual(await h.integrityViolations(), { mismatched: [], negative: [], badReceipts: [] });
});

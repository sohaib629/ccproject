// Sales, restocks, adjustments, stock views and transaction atomicity.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const h = require("./helpers/setup");

let server, api, staffDT, managerDT, staffNY, admin, MBA, PS5;

before(async () => {
  await h.resetDatabase();
  server = await h.startServer();
  api = h.apiClient(server.baseUrl);
  [staffDT, managerDT, staffNY, admin] = await Promise.all([
    api.login("staff.dt@stocksync.dev"),
    api.login("manager.dt@stocksync.dev"),
    api.login("staff.ny@stocksync.dev"),
    api.login("admin@stocksync.dev"),
  ]);
  MBA = await h.ids("DT", "LAP-MBA13-M4"); // seeded with 5 units at Downtown
  PS5 = await h.ids("DT", "CON-PS5-SLIM"); // seeded with 1 unit at Downtown (below threshold)
});

after(async () => {
  await server.close();
});

describe("stock views", () => {
  test("GET /api/stock shows the MacBook Air at Downtown with 5 units", async () => {
    const res = await api.get(`/api/stock?storeId=${MBA.storeId}&productId=${MBA.productId}`, { token: staffDT });
    assert.equal(res.status, 200);
    assert.equal(res.body.stock.length, 1);
    assert.equal(res.body.stock[0].quantity, 5);
    assert.equal(res.body.stock[0].storeCode, "DT");
  });

  test("GET /api/products includes per-store quantities", async () => {
    const res = await api.get("/api/products?q=MacBook", { token: staffNY });
    assert.equal(res.status, 200);
    // Two stores plus the distribution centre (migration 001 gives it 40).
    assert.deepEqual(res.body.products[0].stock, { DT: 5, NY: 8, WH: 40 });
    assert.equal(res.body.products[0].totalQuantity, 53);
  });

  test("GET /api/low-stock lists rows at or below their reorder threshold", async () => {
    const res = await api.get("/api/low-stock", { token: staffDT });
    assert.equal(res.status, 200);
    assert.ok(res.body.lowStock.some((r) => r.sku === "CON-PS5-SLIM" && r.storeCode === "DT"));
    assert.ok(res.body.lowStock.every((r) => r.quantity <= r.reorderThreshold));
  });

  test("stock endpoints require login", async () => {
    assert.equal((await api.get("/api/stock")).status, 401);
  });
});

describe("sales", () => {
  test("first complete workflow: 5 laptops -> sell 1 -> 4, with an audit entry", async () => {
    const res = await api.post("/api/sales", {
      token: staffDT,
      body: { storeId: MBA.storeId, productId: MBA.productId, quantity: 1 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.sale.quantityAfter, 4);
    assert.equal(await h.quantity("DT", "LAP-MBA13-M4"), 4);

    const audit = await api.get(`/api/movements?productId=${MBA.productId}&type=sale`, { token: staffDT });
    assert.equal(audit.status, 200);
    assert.equal(audit.body.movements.length, 1);
    const [m] = audit.body.movements;
    assert.equal(m.id, res.body.sale.movementId);
    assert.equal(m.quantityChange, -1);
    assert.equal(m.quantityAfter, 4);
    assert.equal(m.userName, "Sam Downtown");
  });

  test("selling more than available returns 409 OUT_OF_STOCK and changes nothing", async () => {
    const movementsBefore = (await h.sql("SELECT count(*)::int AS n FROM stock_movements"))[0].n;
    const res = await api.post("/api/sales", {
      token: staffDT,
      body: { storeId: MBA.storeId, productId: MBA.productId, quantity: 50 },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "OUT_OF_STOCK");
    assert.deepEqual(res.body.error.details, { available: 4, requested: 50 });
    assert.equal(await h.quantity("DT", "LAP-MBA13-M4"), 4);
    assert.equal((await h.sql("SELECT count(*)::int AS n FROM stock_movements"))[0].n, movementsBefore);
  });

  test("staff cannot sell at another store (403)", async () => {
    const res = await api.post("/api/sales", {
      token: staffNY,
      body: { storeId: MBA.storeId, productId: MBA.productId, quantity: 1 },
    });
    assert.equal(res.status, 403);
    assert.equal(await h.quantity("DT", "LAP-MBA13-M4"), 4);
  });

  test("invalid input is rejected before touching the database (400)", async () => {
    for (const body of [
      { storeId: MBA.storeId, productId: MBA.productId, quantity: 0 },
      { storeId: MBA.storeId, productId: MBA.productId, quantity: -2 },
      { storeId: MBA.storeId, productId: MBA.productId, quantity: 1.5 },
      { storeId: MBA.storeId, productId: MBA.productId },
    ]) {
      const res = await api.post("/api/sales", { token: staffDT, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test("unknown product returns 404", async () => {
    const res = await api.post("/api/sales", {
      token: staffDT,
      body: { storeId: MBA.storeId, productId: 99999, quantity: 1 },
    });
    assert.equal(res.status, 404);
  });

  test("atomicity: if the audit insert fails, the stock decrease is rolled back", async () => {
    // A validly signed token for a user id that does not exist: the stock UPDATE
    // succeeds, then the audit INSERT fails its foreign key. The transaction must
    // undo the UPDATE.
    const ghost = jwt.sign({ role: "staff", storeId: MBA.storeId, name: "Ghost" }, h.config.jwt.secret, {
      subject: "99999", issuer: h.config.jwt.issuer, algorithm: "HS256", expiresIn: "5m",
    });
    const before = await h.quantity("DT", "LAP-MBA13-M4");
    const res = await api.post("/api/sales", {
      token: ghost,
      body: { storeId: MBA.storeId, productId: MBA.productId, quantity: 1 },
    });
    assert.equal(res.status, 400); // foreign key violation mapped to 400
    assert.equal(await h.quantity("DT", "LAP-MBA13-M4"), before, "stock must be unchanged");
  });
});

describe("restocks and adjustments", () => {
  test("a supplier delivery (restock) at the distribution centre adds units and is audited", async () => {
    const staffWH = await api.login("staff.wh@stocksync.dev");
    const wh = await h.ids("WH", "CON-PS5-SLIM"); // 30 at the distribution centre
    const res = await api.post("/api/restocks", {
      token: staffWH,
      body: { storeId: wh.storeId, productId: wh.productId, quantity: 4, note: "Delivery #1042" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.restock.quantityAfter, 34);
    const [m] = (await api.get(`/api/movements?productId=${wh.productId}&type=restock`, { token: staffWH })).body.movements;
    assert.equal(m.quantityChange, 4);
    assert.equal(m.reason, "Delivery #1042");
  });

  test("a store cannot receive supplier deliveries: 409 WRONG_LOCATION_TYPE, nothing changes", async () => {
    const before = await h.quantity("DT", "CON-PS5-SLIM");
    const res = await api.post("/api/restocks", {
      token: staffDT,
      body: { storeId: PS5.storeId, productId: PS5.productId, quantity: 4 },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "WRONG_LOCATION_TYPE");
    assert.equal(await h.quantity("DT", "CON-PS5-SLIM"), before);
  });

  test("nothing can be sold at the distribution centre: 409 WRONG_LOCATION_TYPE", async () => {
    const wh = await h.ids("WH", "CON-PS5-SLIM");
    const res = await api.post("/api/sales", {
      token: admin,
      body: { storeId: wh.storeId, productId: wh.productId, quantity: 1 },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "WRONG_LOCATION_TYPE");
  });

  test("the database itself refuses a sale at the distribution centre (trigger, last line of defence)", async () => {
    const wh = await h.ids("WH", "CON-PS5-SLIM");
    await assert.rejects(
      h.sql(
        `INSERT INTO stock_movements (store_id, product_id, user_id, movement_type, quantity_change, quantity_after)
         VALUES ($1, $2, (SELECT id FROM users WHERE email = 'admin@stocksync.dev'), 'sale', -1, 0)`,
        [wh.storeId, wh.productId],
      ),
      (err) => err.code === "23514" && err.constraint === "movements_sale_at_store",
    );
  });

  test("staff cannot make adjustments (403)", async () => {
    const res = await api.post("/api/adjustments", {
      token: staffDT,
      body: { storeId: PS5.storeId, productId: PS5.productId, change: -1, reason: "Damaged box" },
    });
    assert.equal(res.status, 403);
  });

  test("adjustments require a reason (400)", async () => {
    const res = await api.post("/api/adjustments", {
      token: managerDT,
      body: { storeId: PS5.storeId, productId: PS5.productId, change: -1 },
    });
    assert.equal(res.status, 400);
  });

  test("a negative adjustment larger than stock returns 409 INSUFFICIENT_STOCK", async () => {
    const res = await api.post("/api/adjustments", {
      token: managerDT,
      body: { storeId: PS5.storeId, productId: PS5.productId, change: -100, reason: "Count correction" },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "INSUFFICIENT_STOCK");
  });

  test("manager adjustment (-1, damaged) succeeds and is audited", async () => {
    // PS5 at Downtown: seeded with 1 (the store restock above was refused).
    const res = await api.post("/api/adjustments", {
      token: managerDT,
      body: { storeId: PS5.storeId, productId: PS5.productId, change: -1, reason: "Water damage in storage" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.adjustment.quantityAfter, 0);
  });

  test("admin can adjust any store", async () => {
    const ny = await h.ids("NY", "CON-XSX-1TB"); // seeded at 0
    const res = await api.post("/api/adjustments", {
      token: admin,
      body: { storeId: ny.storeId, productId: ny.productId, change: 2, reason: "Found in back room" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.adjustment.quantityAfter, 2);
  });
});

describe("audit history access", () => {
  test("staff cannot read another store's history (403)", async () => {
    const res = await api.get(`/api/movements?storeId=${MBA.storeId}`, { token: staffNY });
    assert.equal(res.status, 403);
  });

  test("history is paginated newest-first", async () => {
    const page1 = await api.get("/api/movements?limit=3", { token: admin });
    assert.equal(page1.body.movements.length, 3);
    const page2 = await api.get(`/api/movements?limit=3&before=${page1.body.nextBefore}`, { token: admin });
    assert.ok(page2.body.movements[0].id < page1.body.movements[2].id);
  });
});

test("integrity: stock equals the sum of its audit history, nothing negative", async () => {
  const v = await h.integrityViolations();
  assert.deepEqual(v, { mismatched: [], negative: [], badReceipts: [] });
});

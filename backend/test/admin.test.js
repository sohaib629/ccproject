// Administration (migration 003): products and user accounts.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers/setup");

const PASSWORD = "StockSync!2026";
let server, api, admin, manager, staff, adminId, DT, WH;

before(async () => {
  await h.resetDatabase();
  server = await h.startServer();
  api = h.apiClient(server.baseUrl);
  [admin, manager, staff] = await Promise.all([
    api.login("admin@stocksync.dev"),
    api.login("manager.dt@stocksync.dev"),
    api.login("staff.dt@stocksync.dev"),
  ]);
  adminId = (await h.sql("SELECT id FROM users WHERE email = 'admin@stocksync.dev'"))[0].id;
  DT = (await h.ids("DT", "LAP-MBA13-M4")).storeId;
  WH = (await h.ids("WH", "LAP-MBA13-M4")).storeId;
});

after(async () => {
  await server.close();
});

const patch = (path, opts) => fetch(server.baseUrl + path, {
  method: "PATCH",
  headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
  body: JSON.stringify(opts.body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

describe("products", () => {
  test("only admins can create, edit or deactivate products (403)", async () => {
    const body = { sku: "TST-NOPE", name: "Nope", category: "Test", priceCents: 100, reorderThreshold: 1 };
    assert.equal((await api.post("/api/products", { token: manager, body })).status, 403);
    assert.equal((await api.post("/api/products", { token: staff, body })).status, 403);
    assert.equal((await api.post("/api/products/1/deactivate", { token: manager })).status, 403);
    assert.equal((await patch("/api/products/1", { token: staff, body: { priceCents: 1 } })).status, 403);
  });

  let created;
  test("admin creates a product: 0 units at every location, change recorded", async () => {
    const res = await api.post("/api/products", {
      token: admin,
      body: { sku: "acc-test-cable", name: "Test Cable 1m", category: "Accessories", priceCents: 1999, reorderThreshold: 5 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    created = res.body.product;
    assert.equal(created.sku, "ACC-TEST-CABLE", "SKU is normalised to upper case");
    assert.deepEqual(created.stock, { DT: 0, NY: 0, WH: 0 });
    const hist = (await api.get(`/api/products/${created.id}/history`, { token: admin })).body.history;
    assert.equal(hist[0].action, "created");
    assert.equal(hist[0].byName, "Avery Admin");
  });

  test("duplicate SKU is refused (409) and bad input is refused (400)", async () => {
    const dup = await api.post("/api/products", {
      token: admin, body: { sku: "ACC-TEST-CABLE", name: "Again", category: "Accessories", priceCents: 1, reorderThreshold: 0 },
    });
    assert.equal(dup.status, 409);
    const bad = await api.post("/api/products", {
      token: admin, body: { sku: "bad sku!", name: "X", category: "", priceCents: -5, reorderThreshold: 0 },
    });
    assert.equal(bad.status, 400);
  });

  test("admin edits price and threshold; only real changes are recorded", async () => {
    const res = await patch(`/api/products/${created.id}`, { token: admin, body: { priceCents: 1499, reorderThreshold: 5 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.product.priceCents, 1499);
    const [last] = (await api.get(`/api/products/${created.id}/history`, { token: admin })).body.history;
    assert.equal(last.action, "updated");
    assert.deepEqual(last.changes, { priceCents: { from: 1999, to: 1499 } }, "unchanged threshold not recorded");
  });

  test("a deactivated product cannot be sold or transferred, is hidden, and keeps its history", async () => {
    const mba = await h.ids("DT", "LAP-MBA13-M4");
    assert.equal((await api.post(`/api/products/${mba.productId}/deactivate`, { token: admin })).status, 200);

    const sale = await api.post("/api/sales", { token: staff, body: { storeId: DT, productId: mba.productId, quantity: 1 } });
    assert.equal(sale.status, 409);
    assert.equal(sale.body.error.code, "PRODUCT_INACTIVE");
    const transfer = await api.post("/api/transfers", {
      token: staff, body: { productId: mba.productId, fromStoreId: WH, toStoreId: DT, quantity: 1 },
    });
    assert.equal(transfer.status, 409);

    const list = (await api.get("/api/products?q=MacBook Air 13", { token: staff })).body.products;
    assert.equal(list.length, 0, "hidden from the catalogue");
    const adminList = (await api.get("/api/products?q=MacBook Air 13&includeInactive=true", { token: admin })).body.products;
    assert.equal(adminList[0].isActive, false, "admins can still find it");
    const history = (await api.get(`/api/movements?productId=${mba.productId}`, { token: admin })).body.movements;
    assert.ok(history.length > 0, "audit history is kept");

    assert.equal((await api.post(`/api/products/${mba.productId}/reactivate`, { token: admin })).status, 200);
    const again = await api.post("/api/sales", { token: staff, body: { storeId: DT, productId: mba.productId, quantity: 1 } });
    assert.equal(again.status, 201);
  });
});

describe("users", () => {
  test("only admins can manage accounts (403)", async () => {
    assert.equal((await api.get("/api/users", { token: manager })).status, 403);
    assert.equal((await api.post("/api/users", { token: manager, body: {} })).status, 403);
  });

  let newUserId;
  test("admin creates a staff account; the new user can log in", async () => {
    const res = await api.post("/api/users", {
      token: admin,
      body: { email: "Taylor.New@stocksync.dev", fullName: "Taylor New", role: "staff", storeId: DT, password: "a-long-password-1" },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.email, "taylor.new@stocksync.dev");
    assert.equal(res.body.user.storeCode, "DT");
    assert.ok(!JSON.stringify(res.body).includes("password"), "no password or hash in the response");
    newUserId = res.body.user.id;
    const login = await api.post("/api/auth/login", { body: { email: "taylor.new@stocksync.dev", password: "a-long-password-1" } });
    assert.equal(login.status, 200);
  });

  test("account rules: role/location must match, short passwords and duplicate emails refused", async () => {
    const base = { email: "x1@stocksync.dev", fullName: "X One", password: "a-long-password-1" };
    assert.equal((await api.post("/api/users", { token: admin, body: { ...base, role: "staff" } })).status, 400, "staff needs a location");
    assert.equal((await api.post("/api/users", { token: admin, body: { ...base, role: "admin", storeId: DT } })).status, 400, "admin has none");
    assert.equal((await api.post("/api/users", { token: admin, body: { ...base, role: "staff", storeId: DT, password: "short" } })).status, 400);
    const dup = await api.post("/api/users", { token: admin, body: { ...base, email: "STAFF.DT@stocksync.dev", role: "staff", storeId: DT } });
    assert.equal(dup.status, 409, "emails are unique, case-insensitively");
  });

  test("deactivating an account ends its sessions immediately and blocks login", async () => {
    const token = await (async () => {
      const r = await api.post("/api/auth/login", { body: { email: "taylor.new@stocksync.dev", password: "a-long-password-1" } });
      return r.body.token;
    })();
    assert.equal((await api.get("/api/auth/me", { token })).status, 200);

    assert.equal((await api.post(`/api/users/${newUserId}/deactivate`, { token: admin })).status, 200);
    assert.equal((await api.get("/api/auth/me", { token })).status, 401, "existing token stops working");
    const login = await api.post("/api/auth/login", { body: { email: "taylor.new@stocksync.dev", password: "a-long-password-1" } });
    assert.equal(login.status, 401, "cannot log in");

    assert.equal((await api.post(`/api/users/${newUserId}/reactivate`, { token: admin })).status, 200);
    const back = await api.post("/api/auth/login", { body: { email: "taylor.new@stocksync.dev", password: "a-long-password-1" } });
    assert.equal(back.status, 200, "can log in again");
    assert.equal((await api.get("/api/auth/me", { token })).status, 401, "the old token stays invalid");
  });

  test("password reset: old password and old sessions stop working, new password works", async () => {
    const old = (await api.post("/api/auth/login", { body: { email: "taylor.new@stocksync.dev", password: "a-long-password-1" } })).body.token;
    const res = await api.post(`/api/users/${newUserId}/password`, { token: admin, body: { password: "another-long-pass-2" } });
    assert.equal(res.status, 200);
    assert.equal((await api.get("/api/auth/me", { token: old })).status, 401);
    assert.equal((await api.post("/api/auth/login", { body: { email: "taylor.new@stocksync.dev", password: "a-long-password-1" } })).status, 401);
    assert.equal((await api.post("/api/auth/login", { body: { email: "taylor.new@stocksync.dev", password: "another-long-pass-2" } })).status, 200);
  });

  test("an admin cannot deactivate their own account (409)", async () => {
    const res = await api.post(`/api/users/${adminId}/deactivate`, { token: admin });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CANNOT_DEACTIVATE_SELF");
  });

  test("account changes are audited without passwords", async () => {
    const { history } = (await api.get(`/api/users/${newUserId}/history`, { token: admin })).body;
    assert.deepEqual(history.map((e) => e.action), ["password_reset", "reactivated", "deactivated", "created"]);
    assert.ok(!JSON.stringify(history).includes("long-pass"), "passwords never recorded");
  });

  test("the admin audit table is append-only", async () => {
    await assert.rejects(h.sql("DELETE FROM admin_audit"), (err) => err.code === "42501");
  });
});

test("the demo password still works for seeded accounts", async () => {
  assert.equal((await api.post("/api/auth/login", { body: { email: "staff.ny@stocksync.dev", password: PASSWORD } })).status, 200);
});

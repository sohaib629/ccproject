// The central correctness claim of StockSync: concurrent sales can never oversell.
// All requests are fired at the same moment (Promise.all) over real HTTP, and the
// API handles them as up to DB_POOL_MAX parallel PostgreSQL transactions.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers/setup");

let server, api, staffDT, managerDT;

before(async () => {
  await h.resetDatabase();
  server = await h.startServer();
  api = h.apiClient(server.baseUrl);
  [staffDT, managerDT] = await Promise.all([
    api.login("staff.dt@stocksync.dev"),
    api.login("manager.dt@stocksync.dev"),
  ]);
});

after(async () => {
  await server.close();
});

function countBy(responses) {
  const counts = {};
  for (const r of responses) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

test("20 simultaneous buyers, 1 unit left: exactly one sale succeeds", async () => {
  const PS5 = await h.ids("DT", "CON-PS5-SLIM"); // seeded with exactly 1 unit
  assert.equal(await h.quantity("DT", "CON-PS5-SLIM"), 1);

  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      api.post("/api/sales", {
        token: i % 2 ? staffDT : managerDT, // two different users racing
        body: { storeId: PS5.storeId, productId: PS5.productId, quantity: 1 },
      }),
    ),
  );

  assert.deepEqual(countBy(responses), { 201: 1, 409: 19 });
  assert.ok(responses.filter((r) => r.status === 409).every((r) => r.body.error.code === "OUT_OF_STOCK"));
  assert.equal(await h.quantity("DT", "CON-PS5-SLIM"), 0, "quantity is zero, not negative");

  const sales = await h.sql(
    `SELECT count(*)::int AS n FROM stock_movements WHERE product_id = $1 AND store_id = $2 AND movement_type = 'sale'`,
    [PS5.productId, PS5.storeId],
  );
  assert.equal(sales[0].n, 1, "exactly one sale in the audit history");
});

test("30 simultaneous single-unit sales against 5 units: exactly 5 succeed", async () => {
  const MBA = await h.ids("DT", "LAP-MBA13-M4"); // seeded with 5
  const responses = await Promise.all(
    Array.from({ length: 30 }, () =>
      api.post("/api/sales", { token: staffDT, body: { storeId: MBA.storeId, productId: MBA.productId, quantity: 1 } }),
    ),
  );
  assert.deepEqual(countBy(responses), { 201: 5, 409: 25 });
  assert.equal(await h.quantity("DT", "LAP-MBA13-M4"), 0);

  // Every successful sale reports a distinct remaining quantity: 4, 3, 2, 1, 0.
  const after = responses.filter((r) => r.status === 201).map((r) => r.body.sale.quantityAfter).sort();
  assert.deepEqual(after, [0, 1, 2, 3, 4]);
});

test("simultaneous sales and stock increases keep stock equal to its audit history", async () => {
  const IP = await h.ids("DT", "PHN-IP17-256"); // seeded with 12
  const requests = [];
  for (let i = 0; i < 20; i++) {
    requests.push(api.post("/api/sales", { token: staffDT, body: { storeId: IP.storeId, productId: IP.productId, quantity: 2 } }));
    requests.push(api.post("/api/adjustments", {
      token: managerDT, body: { storeId: IP.storeId, productId: IP.productId, change: 1, reason: "Concurrency test" },
    }));
  }
  const responses = await Promise.all(requests);
  const sold = responses.filter((r) => r.status === 201 && r.body.sale).length * 2;
  const restocked = responses.filter((r) => r.status === 201 && r.body.adjustment).length;
  assert.equal(restocked, 20, "increases never fail");
  assert.equal(await h.quantity("DT", "PHN-IP17-256"), 12 + restocked - sold);
});

test("integrity holds after all the races", async () => {
  assert.deepEqual(await h.integrityViolations(), { mismatched: [], negative: [], badReceipts: [] });
});

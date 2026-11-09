#!/usr/bin/env node
// =============================================================================
// Last-unit race test against ANY running StockSync deployment.
//
//   node tests/concurrency-test.mjs                                # Docker Compose (localhost:3000)
//   API_URL=http://127.0.0.1:8080 node tests/concurrency-test.mjs  # minikube (Day 4)
//   API_URL=https://your-domain   node tests/concurrency-test.mjs  # DigitalOcean (Day 5)
//
// What it does (all through the public API, fully audited, no SQL):
//   1. Admin sets one product at one store to exactly 1 unit (an adjustment).
//   2. N buyers try to buy that unit at the same moment.
//   3. Verifies: exactly 1 success, N-1 OUT_OF_STOCK, final quantity 0,
//      exactly 1 new sale in the audit history.
//   4. Restores the original quantity (another adjustment), so it is safe to run
//      against the development or demo database.
// It also reports which API replicas (X-Instance header) handled the requests.
// =============================================================================

const API = (process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");
const BUYERS = Number(process.env.BUYERS || 20);
const PASSWORD = process.env.DEMO_PASSWORD || "StockSync!2026";
const STORE_CODE = process.env.STORE_CODE || "DT";
const SKU = process.env.SKU || "CON-XSX-1TB";

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, instance: res.headers.get("x-instance") };
}

async function login(email) {
  const r = await call("POST", "/api/auth/login", null, { email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

async function currentStock(token, storeId, productId) {
  const r = await call("GET", `/api/stock?storeId=${storeId}&productId=${productId}`, token);
  return r.body.stock[0]?.quantity ?? 0;
}

async function adjustTo(token, storeId, productId, target, reason) {
  const now = await currentStock(token, storeId, productId);
  if (now === target) return;
  const r = await call("POST", "/api/adjustments", token, { storeId, productId, change: target - now, reason });
  if (r.status !== 201) throw new Error(`adjustment failed: ${r.status} ${JSON.stringify(r.body)}`);
}

async function main() {
  console.log(`Last-unit race test: ${BUYERS} buyers, ${SKU} at ${STORE_CODE}, against ${API}\n`);

  const admin = await login("admin@stocksync.dev");
  const managerEmail = `manager.${STORE_CODE.toLowerCase()}@stocksync.dev`;
  const staffEmail = `staff.${STORE_CODE.toLowerCase()}@stocksync.dev`;
  const buyers = [await login(staffEmail), await login(managerEmail)];

  const store = (await call("GET", "/api/stores", admin)).body.stores.find((s) => s.code === STORE_CODE);
  const product = (await call("GET", `/api/products?q=${encodeURIComponent(SKU)}`, admin)).body.products.find((p) => p.sku === SKU);
  if (!store || !product) throw new Error("store or product not found");

  const original = await currentStock(admin, store.id, product.id);
  const lastSale = (await call("GET", `/api/movements?storeId=${store.id}&productId=${product.id}&type=sale&limit=1`, admin)).body.movements[0]?.id ?? 0;

  await adjustTo(admin, store.id, product.id, 1, "Concurrency test setup: set to 1 unit");
  console.log(`Setup: ${SKU} at ${STORE_CODE} set to 1 unit (was ${original})`);

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: BUYERS }, (_, i) =>
      call("POST", "/api/sales", buyers[i % buyers.length], { storeId: store.id, productId: product.id, quantity: 1 }),
    ),
  );
  const elapsed = Date.now() - started;

  const ok = results.filter((r) => r.status === 201).length;
  const outOfStock = results.filter((r) => r.status === 409 && r.body?.error?.code === "OUT_OF_STOCK").length;
  const other = results.length - ok - outOfStock;
  const final = await currentStock(admin, store.id, product.id);
  const newSales = (await call("GET", `/api/movements?storeId=${store.id}&productId=${product.id}&type=sale&limit=200`, admin))
    .body.movements.filter((m) => m.id > lastSale).length;
  const instances = {};
  for (const r of results) instances[r.instance] = (instances[r.instance] || 0) + 1;

  await adjustTo(admin, store.id, product.id, original, "Concurrency test teardown: restore original quantity");

  const checks = [
    ["exactly 1 sale succeeded", ok === 1, ok],
    [`${BUYERS - 1} got OUT_OF_STOCK`, outOfStock === BUYERS - 1, outOfStock],
    ["no other errors", other === 0, other],
    ["final quantity is 0 (not negative)", final === 0, final],
    ["exactly 1 new sale in the audit history", newSales === 1, newSales],
  ];
  console.log(`\n${BUYERS} requests completed in ${elapsed} ms`);
  console.log("Requests handled per API replica:", instances);
  for (const [label, pass, actual] of checks) console.log(`  ${pass ? "PASS" : "FAIL"}  ${label} (actual: ${actual})`);
  console.log(`Teardown: quantity restored to ${original}`);

  if (checks.some(([, pass]) => !pass)) process.exit(1);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});

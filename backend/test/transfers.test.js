// Transfer lifecycle: requested -> in_transit -> received / cancelled,
// including permission rules and races on dispatch and receive.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers/setup");

let server, api, tok, DT, NY, MBA;

before(async () => {
  await h.resetDatabase();
  server = await h.startServer();
  api = h.apiClient(server.baseUrl);
  const emails = {
    staffDT: "staff.dt@stocksync.dev", managerDT: "manager.dt@stocksync.dev",
    staffNY: "staff.ny@stocksync.dev", managerNY: "manager.ny@stocksync.dev",
    admin: "admin@stocksync.dev",
  };
  tok = {};
  for (const [k, email] of Object.entries(emails)) tok[k] = await api.login(email);
  const ids = await h.ids("DT", "LAP-MBA13-M4");
  DT = ids.storeId;
  MBA = ids.productId;
  NY = (await h.ids("NY", "LAP-MBA13-M4")).storeId;
  // Downtown starts with only 5 MacBooks; these tests dispatch many transfers.
  // (Stores cannot receive supplier deliveries, so the setup uses an adjustment.)
  const setup = await api.post("/api/adjustments", {
    token: tok.managerDT, body: { storeId: DT, productId: MBA, change: 50, reason: "Test setup" },
  });
  assert.equal(setup.status, 201);
});

after(async () => {
  await server.close();
});

/** North York asks Downtown for `quantity` MacBooks. */
async function requestDTtoNY(quantity, token = tok.staffNY) {
  const res = await api.post("/api/transfers", {
    token, body: { productId: MBA, fromStoreId: DT, toStoreId: NY, quantity, note: "Customer waiting at NY" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.transfer;
}

const movementsFor = (transferId) =>
  h.sql(`SELECT movement_type, store_id, quantity_change FROM stock_movements WHERE transfer_id = $1 ORDER BY id`, [transferId]);

describe("happy path", () => {
  test("request -> dispatch -> receive moves units exactly once, fully audited", async () => {
    const dt0 = await h.quantity("DT", "LAP-MBA13-M4");
    const ny0 = await h.quantity("NY", "LAP-MBA13-M4");

    const t = await requestDTtoNY(2);
    assert.equal(t.status, "requested");
    assert.equal(await h.quantity("DT", "LAP-MBA13-M4"), dt0, "requesting moves no stock");

    const d = await api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.managerDT });
    assert.equal(d.status, 200);
    assert.equal(d.body.transfer.status, "in_transit");
    assert.equal(await h.quantity("DT", "LAP-MBA13-M4"), dt0 - 2, "units leave the source on dispatch");
    assert.equal(await h.quantity("NY", "LAP-MBA13-M4"), ny0, "and are not yet at the destination");

    const r = await api.post(`/api/transfers/${t.id}/receive`, { token: tok.staffNY });
    assert.equal(r.status, 200);
    assert.equal(r.body.transfer.status, "received");
    assert.equal(await h.quantity("NY", "LAP-MBA13-M4"), ny0 + 2);

    assert.deepEqual(await movementsFor(t.id), [
      { movement_type: "transfer_out", store_id: DT, quantity_change: -2 },
      { movement_type: "transfer_in", store_id: NY, quantity_change: 2 },
    ]);
  });
});

describe("rules and permissions", () => {
  test("a transfer to the same store is rejected (400)", async () => {
    const res = await api.post("/api/transfers", {
      token: tok.managerDT, body: { productId: MBA, fromStoreId: DT, toStoreId: DT, quantity: 1 },
    });
    assert.equal(res.status, 400);
  });

  test("only a manager of the SOURCE store (or admin) can dispatch", async () => {
    const t = await requestDTtoNY(1);
    assert.equal((await api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.staffDT })).status, 403);
    assert.equal((await api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.managerNY })).status, 403);
    assert.equal((await api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.managerDT })).status, 200);
  });

  test("only the DESTINATION store can receive", async () => {
    const t = await requestDTtoNY(1);
    await api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.managerDT });
    assert.equal((await api.post(`/api/transfers/${t.id}/receive`, { token: tok.managerDT })).status, 403);
    assert.equal((await api.post(`/api/transfers/${t.id}/receive`, { token: tok.staffNY })).status, 200);
  });

  test("dispatching twice is rejected (409 INVALID_TRANSFER_STATE)", async () => {
    const t = await requestDTtoNY(1);
    assert.equal((await api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.managerDT })).status, 200);
    const again = await api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.managerDT });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "INVALID_TRANSFER_STATE");
  });

  test("receiving a transfer that was never dispatched is rejected (409)", async () => {
    const t = await requestDTtoNY(1);
    assert.equal((await api.post(`/api/transfers/${t.id}/receive`, { token: tok.staffNY })).status, 409);
  });

  test("dispatch with insufficient source stock fails and the transfer stays requested", async () => {
    const dt0 = await h.quantity("DT", "LAP-MBA13-M4");
    const t = await requestDTtoNY(dt0 + 10);
    const res = await api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.managerDT });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "INSUFFICIENT_STOCK");
    assert.equal((await api.get(`/api/transfers/${t.id}`, { token: tok.managerDT })).body.transfer.status, "requested");
    assert.equal(await h.quantity("DT", "LAP-MBA13-M4"), dt0);
    assert.deepEqual(await movementsFor(t.id), []);
  });
});

describe("cancellation", () => {
  test("cancelling a requested transfer moves no stock", async () => {
    const dt0 = await h.quantity("DT", "LAP-MBA13-M4");
    const t = await requestDTtoNY(1);
    const res = await api.post(`/api/transfers/${t.id}/cancel`, { token: tok.managerNY, body: { reason: "No longer needed" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.transfer.status, "cancelled");
    assert.equal(await h.quantity("DT", "LAP-MBA13-M4"), dt0);
    assert.deepEqual(await movementsFor(t.id), []);
  });

  test("cancelling an in-transit transfer returns the units to the source (transfer_return)", async () => {
    const t = await requestDTtoNY(1);
    await api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.managerDT });
    const dtAfterDispatch = await h.quantity("DT", "LAP-MBA13-M4");

    const res = await api.post(`/api/transfers/${t.id}/cancel`, { token: tok.managerDT, body: { reason: "Courier lost the slot" } });
    assert.equal(res.status, 200);
    assert.equal(await h.quantity("DT", "LAP-MBA13-M4"), dtAfterDispatch + 1);
    assert.deepEqual((await movementsFor(t.id)).map((m) => m.movement_type), ["transfer_out", "transfer_return"]);

    // ...and it can no longer be received.
    assert.equal((await api.post(`/api/transfers/${t.id}/receive`, { token: tok.staffNY })).status, 409);
  });

  test("a received transfer cannot be cancelled; staff cannot cancel", async () => {
    const t = await requestDTtoNY(1);
    assert.equal((await api.post(`/api/transfers/${t.id}/cancel`, { token: tok.staffNY })).status, 403);
    await api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.managerDT });
    await api.post(`/api/transfers/${t.id}/receive`, { token: tok.staffNY });
    assert.equal((await api.post(`/api/transfers/${t.id}/cancel`, { token: tok.admin })).status, 409);
  });
});

describe("races", () => {
  test("10 simultaneous 'receive' clicks: units arrive exactly once", async () => {
    const t = await requestDTtoNY(1);
    await api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.managerDT });
    const ny0 = await h.quantity("NY", "LAP-MBA13-M4");

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        api.post(`/api/transfers/${t.id}/receive`, { token: i % 2 ? tok.staffNY : tok.managerNY }),
      ),
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 9);
    assert.equal(await h.quantity("NY", "LAP-MBA13-M4"), ny0 + 1);
    assert.equal((await movementsFor(t.id)).filter((m) => m.movement_type === "transfer_in").length, 1);
  });

  test("10 simultaneous 'dispatch' clicks: units leave the source exactly once", async () => {
    const t = await requestDTtoNY(1);
    const dt0 = await h.quantity("DT", "LAP-MBA13-M4");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.managerDT })),
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(await h.quantity("DT", "LAP-MBA13-M4"), dt0 - 1);
  });

  test("receive and cancel racing: exactly one wins, no units lost or duplicated", async () => {
    const t = await requestDTtoNY(1);
    await api.post(`/api/transfers/${t.id}/dispatch`, { token: tok.managerDT });
    const total0 = (await h.quantity("DT", "LAP-MBA13-M4")) + (await h.quantity("NY", "LAP-MBA13-M4"));

    const [rec, can] = await Promise.all([
      api.post(`/api/transfers/${t.id}/receive`, { token: tok.staffNY }),
      api.post(`/api/transfers/${t.id}/cancel`, { token: tok.managerDT }),
    ]);
    assert.deepEqual([rec.status, can.status].sort(), [200, 409]);
    const total1 = (await h.quantity("DT", "LAP-MBA13-M4")) + (await h.quantity("NY", "LAP-MBA13-M4"));
    assert.equal(total1, total0 + 1, "the in-transit unit lands in exactly one store");
  });
});

describe("visibility", () => {
  test("staff see only transfers involving their store", async () => {
    const res = await api.get("/api/transfers", { token: tok.staffDT });
    assert.equal(res.status, 200);
    assert.ok(res.body.transfers.every((t) => t.fromStoreId === DT || t.toStoreId === DT));
  });
});

test("integrity holds after all transfer operations", async () => {
  assert.deepEqual(await h.integrityViolations(), { mismatched: [], negative: [], badReceipts: [] });
});

// =============================================================================
// Inventory service: every operation that changes stock lives here.
//
// Rules followed by EVERY function in this file:
//   1. One database transaction per operation (db.withTransaction).
//   2. The stock change and its audit row (stock_movements) are written in that
//      same transaction, so they commit together or not at all.
//   3. Decreases use a CONDITIONAL update ("... WHERE quantity >= n"). PostgreSQL
//      locks the row, so concurrent requests queue up and each one re-checks the
//      condition against the latest committed quantity. Overselling is impossible
//      without any locks in Node.js, which is why it works across API replicas.
//   4. Transfers lock their row (SELECT ... FOR UPDATE) before checking the
//      status, so two simultaneous "receive" clicks cannot both succeed.
//   5. Location rules (migration 001): sales only at stores, supplier
//      deliveries (restocks) only at the distribution centre. Checked here for a
//      clear error, and enforced again by a database trigger.
// =============================================================================
const db = require("../db");
const { canActOnStore } = require("../middleware/auth");
const { AppError, conflict, forbidden, notFound } = require("../lib/errors");

// ---------------------------------------------------------------------------
// Shared helpers (all take the transaction's `client`)
// ---------------------------------------------------------------------------

/** Append one audit row. Returns it. */
async function recordMovement(client, m) {
  const { rows } = await client.query(
    `INSERT INTO stock_movements
         (store_id, product_id, user_id, movement_type, quantity_change, quantity_after, transfer_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at AS "createdAt"`,
    [m.storeId, m.productId, m.userId, m.type, m.change, m.after, m.transferId ?? null, m.reason ?? null],
  );
  return rows[0];
}

/** Throw 404/409 unless the store exists and the product exists and is active. */
async function assertStoreAndActiveProduct(client, storeId, productId) {
  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM stores WHERE id = $1)::int AS store_found,
            (SELECT is_active FROM products WHERE id = $2) AS product_active`,
    [storeId, productId],
  );
  const { store_found: storeFound, product_active: productActive } = rows[0];
  if (!storeFound) throw notFound("Store not found");
  if (productActive === null) throw notFound("Product not found");
  if (!productActive) throw conflict("PRODUCT_INACTIVE", "Product is no longer sold");
}

/**
 * Atomically decrease stock by `quantity` only if enough units remain.
 * Returns the new quantity, or throws 409 OUT_OF_STOCK with what is available.
 */
async function decreaseStock(client, { storeId, productId, quantity, code = "OUT_OF_STOCK" }) {
  const { rows } = await client.query(
    `UPDATE stock
        SET quantity = quantity - $3, updated_at = now()
      WHERE store_id = $1 AND product_id = $2 AND quantity >= $3
        AND EXISTS (SELECT 1 FROM products WHERE id = $2 AND is_active)
      RETURNING quantity`,
    [storeId, productId, quantity],
  );
  if (rows.length === 1) return rows[0].quantity;

  // No row updated: find out why, for a precise error message.
  await assertStoreAndActiveProduct(client, storeId, productId);
  const current = await client.query(
    `SELECT quantity FROM stock WHERE store_id = $1 AND product_id = $2`,
    [storeId, productId],
  );
  const available = current.rows[0]?.quantity ?? 0;
  throw conflict(code, `Not enough stock: ${available} available, ${quantity} requested`, {
    available,
    requested: quantity,
  });
}

/** Increase stock, creating the (store, product) row if it does not exist yet. Returns the new quantity. */
async function increaseStock(client, { storeId, productId, quantity }) {
  const { rows } = await client.query(
    `INSERT INTO stock (store_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (store_id, product_id)
     DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity, updated_at = now()
     RETURNING quantity`,
    [storeId, productId, quantity],
  );
  return rows[0].quantity;
}

/** 'store' | 'warehouse' for a location; 404 if it does not exist. */
async function locationKind(client, storeId) {
  const { rows } = await client.query(`SELECT kind FROM stores WHERE id = $1`, [storeId]);
  if (!rows[0]) throw notFound("Store not found");
  return rows[0].kind;
}

const WRONG_LOCATION = {
  sale: "Sales are recorded at stores, not at the distribution centre",
  restock: "Supplier deliveries are received at the distribution centre; stores are replenished by transfer",
};

function assertStoreAccess(user, storeId) {
  if (!canActOnStore(user, storeId)) {
    throw forbidden("You can only change stock at your own store");
  }
}

// ---------------------------------------------------------------------------
// Sales, restocks, adjustments
// ---------------------------------------------------------------------------

async function recordSale(user, { storeId, productId, quantity, note }) {
  assertStoreAccess(user, storeId);
  return db.withTransaction(async (client) => {
    if ((await locationKind(client, storeId)) !== "store") {
      throw conflict("WRONG_LOCATION_TYPE", WRONG_LOCATION.sale);
    }
    const after = await decreaseStock(client, { storeId, productId, quantity });
    const movement = await recordMovement(client, {
      storeId, productId, userId: user.id, type: "sale", change: -quantity, after, reason: note,
    });
    return { movementId: movement.id, storeId, productId, quantitySold: quantity, quantityAfter: after, createdAt: movement.createdAt };
  });
}

/** Supplier delivery received at the distribution centre. */
async function recordRestock(user, { storeId, productId, quantity, note }) {
  assertStoreAccess(user, storeId);
  return db.withTransaction(async (client) => {
    if ((await locationKind(client, storeId)) !== "warehouse") {
      throw conflict("WRONG_LOCATION_TYPE", WRONG_LOCATION.restock);
    }
    await assertStoreAndActiveProduct(client, storeId, productId);
    const after = await increaseStock(client, { storeId, productId, quantity });
    const movement = await recordMovement(client, {
      storeId, productId, userId: user.id, type: "restock", change: quantity, after, reason: note,
    });
    return { movementId: movement.id, storeId, productId, quantityAdded: quantity, quantityAfter: after, createdAt: movement.createdAt };
  });
}

/** Manager/admin correction after a physical count, damage or theft. `change` may be negative. */
async function recordAdjustment(user, { storeId, productId, change, reason }) {
  assertStoreAccess(user, storeId);
  return db.withTransaction(async (client) => {
    let after;
    if (change > 0) {
      await assertStoreAndActiveProduct(client, storeId, productId);
      after = await increaseStock(client, { storeId, productId, quantity: change });
    } else {
      after = await decreaseStock(client, { storeId, productId, quantity: -change, code: "INSUFFICIENT_STOCK" });
    }
    const movement = await recordMovement(client, {
      storeId, productId, userId: user.id, type: "adjustment", change, after, reason,
    });
    return { movementId: movement.id, storeId, productId, change, quantityAfter: after, createdAt: movement.createdAt };
  });
}

// ---------------------------------------------------------------------------
// Transfers: requested -> in_transit -> received   (or -> cancelled)
// ---------------------------------------------------------------------------

const TRANSFER_COLUMNS = `
  t.id, t.product_id AS "productId", p.sku, p.name AS "productName",
  t.from_store_id AS "fromStoreId", fs.code AS "fromStoreCode",
  t.to_store_id   AS "toStoreId",   ts.code AS "toStoreCode",
  t.quantity, t.status, t.note,
  t.requested_by  AS "requestedBy",  t.requested_at  AS "requestedAt",
  t.dispatched_by AS "dispatchedBy", t.dispatched_at AS "dispatchedAt",
  t.received_by   AS "receivedBy",   t.received_at   AS "receivedAt",
  t.cancelled_by  AS "cancelledBy",  t.cancelled_at  AS "cancelledAt"`;

const TRANSFER_FROM = `
  FROM transfers t
  JOIN products p ON p.id = t.product_id
  JOIN stores fs  ON fs.id = t.from_store_id
  JOIN stores ts  ON ts.id = t.to_store_id`;

async function getTransfer(clientOrDb, id) {
  const { rows } = await clientOrDb.query(`SELECT ${TRANSFER_COLUMNS} ${TRANSFER_FROM} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw notFound("Transfer not found");
  return rows[0];
}

/** Lock the transfer row for the rest of the transaction. Concurrent actions on it wait here. */
async function lockTransfer(client, id) {
  const { rows } = await client.query(
    `SELECT id, product_id, from_store_id, to_store_id, quantity, status
       FROM transfers WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw notFound("Transfer not found");
  return rows[0];
}

function invalidState(transfer, action) {
  return new AppError(409, "INVALID_TRANSFER_STATE", `Cannot ${action} a transfer that is ${transfer.status}`, {
    status: transfer.status,
  });
}

async function requestTransfer(user, { productId, fromStoreId, toStoreId, quantity, note }) {
  // Either store may start a transfer: the destination asking for units, or the
  // source offering them. Admins may create any transfer.
  if (user.role !== "admin" && user.storeId !== fromStoreId && user.storeId !== toStoreId) {
    throw forbidden("You can only request transfers involving your own store");
  }
  return db.withTransaction(async (client) => {
    await assertStoreAndActiveProduct(client, fromStoreId, productId);
    await assertStoreAndActiveProduct(client, toStoreId, productId);
    const { rows } = await client.query(
      `INSERT INTO transfers (product_id, from_store_id, to_store_id, quantity, note, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [productId, fromStoreId, toStoreId, quantity, note ?? null, user.id],
    );
    return getTransfer(client, rows[0].id);
  });
}

/** Source-store manager (or admin) ships the units: stock leaves the source now. */
async function dispatchTransfer(user, id) {
  return db.withTransaction(async (client) => {
    const t = await lockTransfer(client, id);
    if (!(user.role === "admin" || (user.role === "manager" && user.storeId === t.from_store_id))) {
      throw forbidden("Only a manager of the source store can dispatch this transfer");
    }
    if (t.status !== "requested") throw invalidState(t, "dispatch");

    // If the source no longer has enough units, this throws and the whole
    // transaction rolls back: the transfer simply stays "requested".
    const after = await decreaseStock(client, {
      storeId: t.from_store_id, productId: t.product_id, quantity: t.quantity, code: "INSUFFICIENT_STOCK",
    });
    await recordMovement(client, {
      storeId: t.from_store_id, productId: t.product_id, userId: user.id,
      type: "transfer_out", change: -t.quantity, after, transferId: t.id,
    });
    await client.query(
      `UPDATE transfers SET status = 'in_transit', dispatched_by = $2, dispatched_at = now() WHERE id = $1`,
      [t.id, user.id],
    );
    return getTransfer(client, t.id);
  });
}

/** Destination store confirms arrival: stock arrives exactly once. */
async function receiveTransfer(user, id) {
  return db.withTransaction(async (client) => {
    const t = await lockTransfer(client, id);
    if (!(user.role === "admin" || user.storeId === t.to_store_id)) {
      throw forbidden("Only the destination store can receive this transfer");
    }
    // A second, simultaneous "receive" waits at lockTransfer, then sees
    // status = 'received' here and is rejected.
    if (t.status !== "in_transit") throw invalidState(t, "receive");

    const after = await increaseStock(client, { storeId: t.to_store_id, productId: t.product_id, quantity: t.quantity });
    await recordMovement(client, {
      storeId: t.to_store_id, productId: t.product_id, userId: user.id,
      type: "transfer_in", change: t.quantity, after, transferId: t.id,
    });
    await client.query(
      `UPDATE transfers SET status = 'received', received_by = $2, received_at = now() WHERE id = $1`,
      [t.id, user.id],
    );
    return getTransfer(client, t.id);
  });
}

/**
 * Cancel a transfer.
 *   requested  -> cancelled: no stock had moved, nothing to undo.
 *   in_transit -> cancelled: units were already deducted at dispatch, so they are
 *                            returned to the source store (compensating 'transfer_return').
 *   received / cancelled  -> rejected.
 */
async function cancelTransfer(user, id, reason) {
  return db.withTransaction(async (client) => {
    const t = await lockTransfer(client, id);
    const involved = user.storeId === t.from_store_id || user.storeId === t.to_store_id;
    if (!(user.role === "admin" || (user.role === "manager" && involved))) {
      throw forbidden("Only a manager of either store can cancel this transfer");
    }
    if (t.status !== "requested" && t.status !== "in_transit") throw invalidState(t, "cancel");

    if (t.status === "in_transit") {
      const after = await increaseStock(client, { storeId: t.from_store_id, productId: t.product_id, quantity: t.quantity });
      await recordMovement(client, {
        storeId: t.from_store_id, productId: t.product_id, userId: user.id,
        type: "transfer_return", change: t.quantity, after, transferId: t.id, reason,
      });
    }
    await client.query(
      `UPDATE transfers
          SET status = 'cancelled', cancelled_by = $2, cancelled_at = now(),
              note = CASE WHEN $3::text IS NULL THEN note ELSE concat_ws(' | ', note, 'Cancelled: ' || $3::text) END
        WHERE id = $1`,
      [t.id, user.id, reason ?? null],
    );
    return getTransfer(client, t.id);
  });
}

module.exports = {
  recordSale,
  recordRestock,
  recordAdjustment,
  requestTransfer,
  dispatchTransfer,
  receiveTransfer,
  cancelTransfer,
  getTransfer,
  TRANSFER_COLUMNS,
  TRANSFER_FROM,
};

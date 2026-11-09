// Transfers between stores: requested -> in_transit -> received (or cancelled).
const { Router } = require("express");
const db = require("../db");
const { authenticate } = require("../middleware/auth");
const { parse } = require("../lib/validate");
const { forbidden } = require("../lib/errors");
const { z, id, quantity, optionalText } = require("../lib/schemas");
const inventory = require("../services/inventory");

const router = Router();
router.use(authenticate);

const newTransfer = z
  .object({ productId: id, fromStoreId: id, toStoreId: id, quantity, note: optionalText })
  .refine((t) => t.fromStoreId !== t.toStoreId, {
    message: "fromStoreId and toStoreId must be different",
    path: ["toStoreId"],
  });

const listQuery = z.object({
  status: z.enum(["requested", "in_transit", "received", "cancelled"]).optional(),
  storeId: id.optional(),
});

const idParam = z.object({ id });

// GET /api/transfers?status=in_transit&storeId=1
// Managers/staff see transfers involving their store; admins see all.
router.get("/", async (req, res) => {
  const { status, storeId } = parse(listQuery, req.query);
  const scopeStore = req.user.role === "admin" ? (storeId ?? null) : req.user.storeId;
  const { rows } = await db.query(
    `SELECT ${inventory.TRANSFER_COLUMNS} ${inventory.TRANSFER_FROM}
      WHERE ($1::text IS NULL OR t.status = $1)
        AND ($2::int IS NULL OR $2 IN (t.from_store_id, t.to_store_id))
      ORDER BY t.requested_at DESC, t.id DESC
      LIMIT 200`,
    [status ?? null, scopeStore],
  );
  res.json({ transfers: rows });
});

// GET /api/transfers/:id
router.get("/:id", async (req, res) => {
  const { id: transferId } = parse(idParam, req.params);
  const transfer = await inventory.getTransfer(db, transferId);
  const involved = [transfer.fromStoreId, transfer.toStoreId].includes(req.user.storeId);
  if (req.user.role !== "admin" && !involved) throw forbidden("This transfer does not involve your store");
  res.json({ transfer });
});

// POST /api/transfers  { productId, fromStoreId, toStoreId, quantity, note? }
router.post("/", async (req, res) => {
  const input = parse(newTransfer, req.body);
  const transfer = await inventory.requestTransfer(req.user, input);
  req.log.info({ transferId: transfer.id }, "transfer requested");
  res.status(201).json({ transfer });
});

// POST /api/transfers/:id/dispatch   (manager of the source store, or admin)
router.post("/:id/dispatch", async (req, res) => {
  const { id: transferId } = parse(idParam, req.params);
  const transfer = await inventory.dispatchTransfer(req.user, transferId);
  req.log.info({ transferId }, "transfer dispatched");
  res.json({ transfer });
});

// POST /api/transfers/:id/receive   (anyone at the destination store, or admin)
router.post("/:id/receive", async (req, res) => {
  const { id: transferId } = parse(idParam, req.params);
  const transfer = await inventory.receiveTransfer(req.user, transferId);
  req.log.info({ transferId }, "transfer received");
  res.json({ transfer });
});

// POST /api/transfers/:id/cancel  { reason? }   (manager of either store, or admin)
router.post("/:id/cancel", async (req, res) => {
  const { id: transferId } = parse(idParam, req.params);
  const { reason } = parse(z.object({ reason: optionalText }), req.body ?? {});
  const transfer = await inventory.cancelTransfer(req.user, transferId, reason);
  req.log.info({ transferId }, "transfer cancelled");
  res.json({ transfer });
});

module.exports = router;

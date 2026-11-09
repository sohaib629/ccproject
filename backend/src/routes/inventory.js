// Stock-changing endpoints: sales, restocks, adjustments.
// The routes only validate input and check roles; the transactional work is in
// services/inventory.js.
const { Router } = require("express");
const { authenticate, requireRole } = require("../middleware/auth");
const { parse } = require("../lib/validate");
const { z, id, quantity, optionalText, requiredReason } = require("../lib/schemas");
const inventory = require("../services/inventory");

const router = Router();
// authenticate is applied per route (not router.use) because this router is
// mounted at /api: unknown /api URLs must still return 404, not 401.

const saleOrRestock = z.object({
  storeId: id,
  productId: id,
  quantity,
  note: optionalText,
});

// POST /api/sales  { storeId, productId, quantity, note? }   (any role, own store)
// 201 on success; 409 OUT_OF_STOCK if not enough units remain.
router.post("/sales", authenticate, async (req, res) => {
  const input = parse(saleOrRestock, req.body);
  const sale = await inventory.recordSale(req.user, input);
  req.log.info({ sale }, "sale recorded");
  res.status(201).json({ sale });
});

// POST /api/restocks  { storeId, productId, quantity, note? }   (any role, own store)
router.post("/restocks", authenticate, async (req, res) => {
  const input = parse(saleOrRestock, req.body);
  const restock = await inventory.recordRestock(req.user, input);
  req.log.info({ restock }, "restock recorded");
  res.status(201).json({ restock });
});

const adjustment = z.object({
  storeId: id,
  productId: id,
  change: z.coerce.number().int().min(-1000).max(1000).refine((n) => n !== 0, "change cannot be 0"),
  reason: requiredReason,
});

// POST /api/adjustments  { storeId, productId, change, reason }   (manager/admin, own store)
// For corrections after a physical count, damage or theft. `change` may be negative.
router.post("/adjustments", authenticate, requireRole("manager", "admin"), async (req, res) => {
  const input = parse(adjustment, req.body);
  const result = await inventory.recordAdjustment(req.user, input);
  req.log.info({ adjustment: result }, "adjustment recorded");
  res.status(201).json({ adjustment: result });
});

module.exports = router;

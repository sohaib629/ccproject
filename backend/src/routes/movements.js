// Audit history (read-only). Staff and managers see their own store; admins see all.
const { Router } = require("express");
const db = require("../db");
const { authenticate } = require("../middleware/auth");
const { parse } = require("../lib/validate");
const { forbidden } = require("../lib/errors");
const { z, id } = require("../lib/schemas");

const router = Router();
router.use(authenticate);

const MOVEMENT_TYPES = ["initial", "sale", "restock", "adjustment", "transfer_out", "transfer_in", "transfer_return"];

const query = z.object({
  storeId: id.optional(),
  productId: id.optional(),
  userId: id.optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  transferId: id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(), // pagination: ids lower than this
});

// GET /api/movements?storeId=1&productId=1&type=sale&limit=50&before=1234
// Newest first. To get the next page, pass before=<nextBefore from the previous response>.
router.get("/", async (req, res) => {
  const f = parse(query, req.query);

  let storeId = f.storeId ?? null;
  if (req.user.role !== "admin") {
    if (storeId !== null && storeId !== req.user.storeId) {
      throw forbidden("You can only view the history of your own store");
    }
    storeId = req.user.storeId;
  }

  const { rows } = await db.query(
    `SELECT m.id, m.created_at AS "createdAt", m.movement_type AS type,
            m.quantity_change AS "quantityChange", m.quantity_after AS "quantityAfter",
            m.store_id AS "storeId", st.code AS "storeCode",
            m.product_id AS "productId", p.sku, p.name AS "productName",
            m.user_id AS "userId", u.full_name AS "userName",
            m.transfer_id AS "transferId", m.reason
       FROM stock_movements m
       JOIN stores st  ON st.id = m.store_id
       JOIN products p ON p.id = m.product_id
       JOIN users u    ON u.id = m.user_id
      WHERE ($1::int  IS NULL OR m.store_id = $1)
        AND ($2::int  IS NULL OR m.product_id = $2)
        AND ($3::int  IS NULL OR m.user_id = $3)
        AND ($4::text IS NULL OR m.movement_type = $4)
        AND ($5::int  IS NULL OR m.transfer_id = $5)
        AND ($6::bigint IS NULL OR m.id < $6)
      ORDER BY m.id DESC
      LIMIT $7`,
    [storeId, f.productId ?? null, f.userId ?? null, f.type ?? null, f.transferId ?? null, f.before ?? null, f.limit],
  );

  const nextBefore = rows.length === f.limit ? rows[rows.length - 1].id : null;
  res.json({ movements: rows, nextBefore });
});

module.exports = router;

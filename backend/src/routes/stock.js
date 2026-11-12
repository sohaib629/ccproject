// Read-only stock views. Every role can see availability at BOTH stores:
// knowing that the other store has a unit is the point of a shared system.
const { Router } = require("express");
const db = require("../db");
const { authenticate } = require("../middleware/auth");
const { parse } = require("../lib/validate");
const { z, id } = require("../lib/schemas");

const router = Router();
// authenticate is applied per route (not router.use) because this router is
// mounted at /api: unknown /api URLs must still return 404, not 401.

const stockQuery = z.object({
  storeId: id.optional(),
  productId: id.optional(),
  category: z.string().trim().min(1).max(50).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  lowOnly: z.enum(["true", "false"]).optional(),
});

// GET /api/stock?storeId=1&productId=1&category=Laptops&q=air&lowOnly=true
router.get("/stock", authenticate, async (req, res) => {
  const f = parse(stockQuery, req.query);
  const { rows } = await db.query(
    `SELECT s.store_id AS "storeId", st.code AS "storeCode",
            p.id AS "productId", p.sku, p.name, p.category,
            p.price_cents AS "priceCents", p.reorder_threshold AS "reorderThreshold",
            s.quantity, (s.quantity <= p.reorder_threshold) AS "isLow",
            s.updated_at AS "updatedAt"
       FROM stock s
       JOIN products p ON p.id = s.product_id
       JOIN stores st  ON st.id = s.store_id
      WHERE p.is_active
        AND ($1::int  IS NULL OR s.store_id = $1)
        AND ($2::int  IS NULL OR s.product_id = $2)
        AND ($3::text IS NULL OR p.category = $3)
        AND ($4::text IS NULL OR p.name ILIKE '%' || $4 || '%' OR p.sku ILIKE '%' || $4 || '%')
        AND ($5::bool IS NOT TRUE OR s.quantity <= p.reorder_threshold)
      ORDER BY st.id, p.category, p.name`,
    [f.storeId ?? null, f.productId ?? null, f.category ?? null, f.q ?? null, f.lowOnly === "true"],
  );
  res.json({ stock: rows });
});

// GET /api/low-stock?storeId=2   (uses the low_stock view from the schema)
//
// Rule-based reorder suggestion for each low STORE row: bring the store up to
// twice its reorder threshold, limited by what the distribution centre has.
//   suggested = min(2 x threshold - quantity, units at the distribution centre)
// A low row AT the distribution centre means "order from the supplier".
router.get("/low-stock", authenticate, async (req, res) => {
  const { storeId } = parse(z.object({ storeId: id.optional() }), req.query);
  const { rows } = await db.query(
    `SELECT l.store_id AS "storeId", l.store_code AS "storeCode", st.kind AS "storeKind",
            l.product_id AS "productId", l.sku, l.product_name AS "name", l.category, l.quantity,
            l.reorder_threshold AS "reorderThreshold", l.shortfall,
            wh.id AS "warehouseId", coalesce(ws.quantity, 0) AS "warehouseQuantity",
            CASE WHEN st.kind = 'store'
                 THEN greatest(0, least(2 * l.reorder_threshold - l.quantity, coalesce(ws.quantity, 0)))
            END AS "suggestedQuantity"
       FROM low_stock l
       JOIN stores st ON st.id = l.store_id
       LEFT JOIN stores wh ON wh.kind = 'warehouse'
       LEFT JOIN stock ws ON ws.store_id = wh.id AND ws.product_id = l.product_id
      WHERE ($1::int IS NULL OR l.store_id = $1)
      ORDER BY l.shortfall DESC, l.store_code, l.sku`,
    [storeId ?? null],
  );
  res.json({ lowStock: rows });
});

module.exports = router;

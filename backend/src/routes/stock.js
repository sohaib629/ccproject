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
router.get("/low-stock", authenticate, async (req, res) => {
  const { storeId } = parse(z.object({ storeId: id.optional() }), req.query);
  const { rows } = await db.query(
    `SELECT store_id AS "storeId", store_code AS "storeCode", product_id AS "productId",
            sku, product_name AS "name", category, quantity,
            reorder_threshold AS "reorderThreshold", shortfall
       FROM low_stock
      WHERE ($1::int IS NULL OR store_id = $1)
      ORDER BY shortfall DESC, store_code, sku`,
    [storeId ?? null],
  );
  res.json({ lowStock: rows });
});

module.exports = router;

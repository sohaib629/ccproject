const { Router } = require("express");
const db = require("../db");
const { authenticate } = require("../middleware/auth");
const { parse } = require("../lib/validate");
const { notFound } = require("../lib/errors");
const { z, id } = require("../lib/schemas");

const router = Router();
router.use(authenticate);

// Each product with its quantity at every store, e.g. stock: { "DT": 5, "NY": 8 }.
const PRODUCT_SELECT = `
  SELECT p.id, p.sku, p.name, p.category,
         p.price_cents AS "priceCents", p.reorder_threshold AS "reorderThreshold",
         coalesce(json_object_agg(st.code, coalesce(s.quantity, 0) ORDER BY st.id)
                  FILTER (WHERE st.id IS NOT NULL), '{}') AS stock,
         coalesce(sum(s.quantity), 0)::int AS "totalQuantity"
    FROM products p
   CROSS JOIN stores st
    LEFT JOIN stock s ON s.product_id = p.id AND s.store_id = st.id`;

const listQuery = z.object({
  category: z.string().trim().min(1).max(50).optional(),
  q: z.string().trim().min(1).max(100).optional(), // search by name or SKU
});

// GET /api/products?category=Laptops&q=macbook
router.get("/", async (req, res) => {
  const { category, q } = parse(listQuery, req.query);
  const { rows } = await db.query(
    `${PRODUCT_SELECT}
      WHERE p.is_active
        AND ($1::text IS NULL OR p.category = $1)
        AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%' OR p.sku ILIKE '%' || $2 || '%')
      GROUP BY p.id
      ORDER BY p.category, p.name`,
    [category ?? null, q ?? null],
  );
  res.json({ products: rows });
});

// GET /api/products/:id
router.get("/:id", async (req, res) => {
  const { id: productId } = parse(z.object({ id }), req.params);
  const { rows } = await db.query(`${PRODUCT_SELECT} WHERE p.id = $1 GROUP BY p.id`, [productId]);
  if (!rows[0]) throw notFound("Product not found");
  res.json({ product: rows[0] });
});

module.exports = router;

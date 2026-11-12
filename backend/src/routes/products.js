// Product catalogue.
//   Everyone:  GET /api/products, GET /api/products/:id
//   Admin:     create, edit, deactivate / reactivate, change history
//
// Products are never deleted: their sales, transfers and audit rows must stay
// meaningful. Deactivating hides a product from selling and new transfers
// (the inventory service already refuses inactive products); units in transit
// can still be received. Every admin change is written to admin_audit.
const { Router } = require("express");
const db = require("../db");
const { authenticate, requireRole } = require("../middleware/auth");
const { parse } = require("../lib/validate");
const { notFound } = require("../lib/errors");
const { z, id } = require("../lib/schemas");
const { recordAdminChange, adminHistory, diff } = require("../services/adminAudit");

const router = Router();
router.use(authenticate);

// Each product with its quantity at every location, e.g. stock: { "DT": 5, "NY": 8, "WH": 40 }.
const PRODUCT_SELECT = `
  SELECT p.id, p.sku, p.name, p.category,
         p.price_cents AS "priceCents", p.reorder_threshold AS "reorderThreshold",
         p.is_active AS "isActive",
         coalesce(json_object_agg(st.code, coalesce(s.quantity, 0) ORDER BY st.id)
                  FILTER (WHERE st.id IS NOT NULL), '{}') AS stock,
         coalesce(sum(s.quantity), 0)::int AS "totalQuantity"
    FROM products p
   CROSS JOIN stores st
    LEFT JOIN stock s ON s.product_id = p.id AND s.store_id = st.id`;

async function getProduct(client, productId) {
  const { rows } = await client.query(`${PRODUCT_SELECT} WHERE p.id = $1 GROUP BY p.id`, [productId]);
  if (!rows[0]) throw notFound("Product not found");
  return rows[0];
}

const listQuery = z.object({
  category: z.string().trim().min(1).max(50).optional(),
  q: z.string().trim().min(1).max(100).optional(), // search by name or SKU
  includeInactive: z.enum(["true", "false"]).optional(), // admin only
});

// GET /api/products?category=Laptops&q=macbook[&includeInactive=true]
router.get("/", async (req, res) => {
  const { category, q, includeInactive } = parse(listQuery, req.query);
  const showInactive = includeInactive === "true" && req.user.role === "admin";
  const { rows } = await db.query(
    `${PRODUCT_SELECT}
      WHERE (p.is_active OR $3::bool)
        AND ($1::text IS NULL OR p.category = $1)
        AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%' OR p.sku ILIKE '%' || $2 || '%')
      GROUP BY p.id
      ORDER BY p.category, p.name`,
    [category ?? null, q ?? null, showInactive],
  );
  res.json({ products: rows });
});

// GET /api/products/:id
router.get("/:id", async (req, res) => {
  const { id: productId } = parse(z.object({ id }), req.params);
  res.json({ product: await getProduct(db, productId) });
});

// --- Admin ------------------------------------------------------------------------
const fields = {
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(50),
  priceCents: z.coerce.number().int().min(0).max(100_000_000),
  reorderThreshold: z.coerce.number().int().min(0).max(1000),
};

const newProduct = z.object({
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,32}$/, "3-32 characters: A-Z, 0-9 and -"),
  ...fields,
});

// POST /api/products  { sku, name, category, priceCents, reorderThreshold }
// Creates the product with 0 units at every location (stock arrives through a
// supplier delivery at the distribution centre).
router.post("/", requireRole("admin"), async (req, res) => {
  const input = parse(newProduct, req.body);
  const product = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO products (sku, name, category, price_cents, reorder_threshold)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.sku, input.name, input.category, input.priceCents, input.reorderThreshold],
    );
    const productId = rows[0].id;
    await client.query(`INSERT INTO stock (store_id, product_id, quantity) SELECT id, $1, 0 FROM stores`, [productId]);
    await recordAdminChange(client, { entity: "product", entityId: productId, action: "created", changes: input, userId: req.user.id });
    return getProduct(client, productId);
  });
  req.log.info({ productId: product.id, sku: product.sku }, "product created");
  res.status(201).json({ product });
});

const productEdit = z
  .object({ name: fields.name.optional(), category: fields.category.optional(),
            priceCents: fields.priceCents.optional(), reorderThreshold: fields.reorderThreshold.optional() })
  .refine((o) => Object.values(o).some((v) => v !== undefined), "Change at least one field");

// PATCH /api/products/:id  { name?, category?, priceCents?, reorderThreshold? }   (SKU never changes)
router.patch("/:id", requireRole("admin"), async (req, res) => {
  const { id: productId } = parse(z.object({ id }), req.params);
  const input = parse(productEdit, req.body);
  const product = await db.withTransaction(async (client) => {
    const before = await getProduct(client, productId);
    const changes = diff(before, input);
    if (Object.keys(changes).length) {
      await client.query(
        `UPDATE products
            SET name = coalesce($2, name), category = coalesce($3, category),
                price_cents = coalesce($4, price_cents), reorder_threshold = coalesce($5, reorder_threshold),
                updated_at = now()
          WHERE id = $1`,
        [productId, input.name ?? null, input.category ?? null, input.priceCents ?? null, input.reorderThreshold ?? null],
      );
      await recordAdminChange(client, { entity: "product", entityId: productId, action: "updated", changes, userId: req.user.id });
    }
    return getProduct(client, productId);
  });
  res.json({ product });
});

async function setActive(req, active) {
  const { id: productId } = parse(z.object({ id }), req.params);
  return db.withTransaction(async (client) => {
    const before = await getProduct(client, productId);
    if (before.isActive === active) return before; // idempotent
    await client.query(`UPDATE products SET is_active = $2, updated_at = now() WHERE id = $1`, [productId, active]);
    await recordAdminChange(client, {
      entity: "product", entityId: productId, action: active ? "reactivated" : "deactivated", userId: req.user.id,
    });
    return getProduct(client, productId);
  });
}

// POST /api/products/:id/deactivate   (hidden from selling and new transfers; history kept)
router.post("/:id/deactivate", requireRole("admin"), async (req, res) => {
  res.json({ product: await setActive(req, false) });
});

// POST /api/products/:id/reactivate
router.post("/:id/reactivate", requireRole("admin"), async (req, res) => {
  res.json({ product: await setActive(req, true) });
});

// GET /api/products/:id/history  ->  admin changes, newest first
router.get("/:id/history", requireRole("admin"), async (req, res) => {
  const { id: productId } = parse(z.object({ id }), req.params);
  await getProduct(db, productId);
  res.json({ history: await adminHistory(db, "product", productId) });
});

module.exports = router;

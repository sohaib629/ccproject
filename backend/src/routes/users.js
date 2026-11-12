// User accounts (admin only): list, create, deactivate / reactivate, reset password.
//
// Rules
//   * Passwords are bcrypt-hashed (cost 12) and never returned or audited.
//   * Deactivating an account or resetting its password bumps token_version, so
//     every existing login of that user stops working at once (see auth.js).
//   * An admin cannot deactivate their own account (no accidental lock-out).
//   * Every change is written to admin_audit in the same transaction.
const { Router } = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { authenticate, requireRole, ROLES } = require("../middleware/auth");
const { parse } = require("../lib/validate");
const { z, id } = require("../lib/schemas");
const { AppError, badRequest, conflict, notFound } = require("../lib/errors");
const { recordAdminChange, adminHistory } = require("../services/adminAudit");

const router = Router();
router.use(authenticate, requireRole("admin"));

const USER_COLUMNS = `
  u.id, u.email, u.full_name AS "fullName", u.role, u.is_active AS "isActive",
  u.store_id AS "storeId", s.code AS "storeCode", s.name AS "storeName", u.created_at AS "createdAt"`;

async function getUser(client, userId) {
  const { rows } = await client.query(
    `SELECT ${USER_COLUMNS} FROM users u LEFT JOIN stores s ON s.id = u.store_id WHERE u.id = $1`,
    [userId],
  );
  if (!rows[0]) throw notFound("User not found");
  return rows[0];
}

const password = z.string().min(10, "Password must have at least 10 characters").max(200);

// GET /api/users  ->  all accounts (never includes password hashes)
router.get("/", async (_req, res) => {
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS} FROM users u LEFT JOIN stores s ON s.id = u.store_id ORDER BY u.is_active DESC, u.id`,
  );
  res.json({ users: rows });
});

const newUser = z
  .object({
    email: z.email().max(254).transform((e) => e.toLowerCase()),
    fullName: z.string().trim().min(2).max(100),
    role: z.enum(ROLES),
    storeId: id.optional().nullable(),
    password,
  })
  .refine((u) => (u.role === "admin" ? u.storeId == null : u.storeId != null), {
    message: "Admins have no location; managers and staff need one",
    path: ["storeId"],
  });

// POST /api/users  { email, fullName, role, storeId?, password }
router.post("/", async (req, res) => {
  const input = parse(newUser, req.body);
  const hash = await bcrypt.hash(input.password, 12);
  const user = await db.withTransaction(async (client) => {
    if (input.storeId != null) {
      const store = await client.query(`SELECT 1 FROM stores WHERE id = $1`, [input.storeId]);
      if (!store.rowCount) throw badRequest("Location not found", { fields: [{ field: "storeId", message: "Unknown location" }] });
    }
    const { rows } = await client.query(
      `INSERT INTO users (email, full_name, password_hash, role, store_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.email, input.fullName, hash, input.role, input.storeId ?? null],
    );
    await recordAdminChange(client, {
      entity: "user", entityId: rows[0].id, action: "created", userId: req.user.id,
      changes: { email: input.email, fullName: input.fullName, role: input.role, storeId: input.storeId ?? null },
    });
    return getUser(client, rows[0].id);
  });
  req.log.info({ userId: user.id, role: user.role }, "user created");
  res.status(201).json({ user });
});

/** Set is_active; bump token_version when deactivating (ends every session). */
async function setActive(req, active) {
  const { id: userId } = parse(z.object({ id }), req.params);
  if (!active && userId === req.user.id) {
    throw new AppError(409, "CANNOT_DEACTIVATE_SELF", "You cannot deactivate your own account");
  }
  return db.withTransaction(async (client) => {
    const before = await getUser(client, userId);
    if (before.isActive === active) return before; // nothing to do (idempotent)
    await client.query(
      `UPDATE users SET is_active = $2, token_version = token_version + CASE WHEN $2 THEN 0 ELSE 1 END WHERE id = $1`,
      [userId, active],
    );
    await recordAdminChange(client, {
      entity: "user", entityId: userId, action: active ? "reactivated" : "deactivated", userId: req.user.id,
    });
    return getUser(client, userId);
  });
}

// POST /api/users/:id/deactivate   (cannot log in; existing sessions end now)
router.post("/:id/deactivate", async (req, res) => {
  res.json({ user: await setActive(req, false) });
});

// POST /api/users/:id/reactivate
router.post("/:id/reactivate", async (req, res) => {
  res.json({ user: await setActive(req, true) });
});

// POST /api/users/:id/password  { password }   (existing sessions end now)
router.post("/:id/password", async (req, res) => {
  const { id: userId } = parse(z.object({ id }), req.params);
  const input = parse(z.object({ password }), req.body);
  const hash = await bcrypt.hash(input.password, 12);
  const user = await db.withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1`,
      [userId, hash],
    );
    if (!rowCount) throw notFound("User not found");
    await recordAdminChange(client, { entity: "user", entityId: userId, action: "password_reset", userId: req.user.id });
    return getUser(client, userId);
  });
  res.json({ user });
});

// GET /api/users/:id/history  ->  admin changes to this account
router.get("/:id/history", async (req, res) => {
  const { id: userId } = parse(z.object({ id }), req.params);
  await getUser(db, userId);
  res.json({ history: await adminHistory(db, "user", userId) });
});

module.exports = router;

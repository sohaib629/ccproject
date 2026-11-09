const { Router } = require("express");
const db = require("../db");
const { authenticate, requireRole } = require("../middleware/auth");

const router = Router();

// Every route in this file is admin-only.
router.use(authenticate, requireRole("admin"));

// GET /api/users  ->  all accounts (never includes password hashes)
router.get("/", async (_req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.full_name AS "fullName", u.role, u.is_active AS "isActive",
            s.code AS "storeCode"
       FROM users u
       LEFT JOIN stores s ON s.id = u.store_id
      ORDER BY u.id`,
  );
  res.json({ users: rows });
});

module.exports = router;

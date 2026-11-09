const { Router } = require("express");
const db = require("../db");
const { authenticate } = require("../middleware/auth");

const router = Router();

// GET /api/stores  (any logged-in user)  ->  both locations
router.get("/", authenticate, async (_req, res) => {
  const { rows } = await db.query(`SELECT id, code, name, address FROM stores ORDER BY id`);
  res.json({ stores: rows });
});

module.exports = router;

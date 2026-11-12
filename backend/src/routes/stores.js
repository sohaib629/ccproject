const { Router } = require("express");
const db = require("../db");
const { authenticate } = require("../middleware/auth");

const router = Router();

// GET /api/stores  (any logged-in user)  ->  every location: the two stores
// and the distribution centre (kind: "store" | "warehouse")
router.get("/", authenticate, async (_req, res) => {
  const { rows } = await db.query(`SELECT id, code, name, address, kind FROM stores ORDER BY kind DESC, id`);
  res.json({ stores: rows });
});

module.exports = router;

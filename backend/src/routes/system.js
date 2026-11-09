// GET /api/system: live infrastructure status for the admin "System" page.
//
// Admin only: versions, table sizes and the route list are useful to an attacker,
// so other roles get 403. No secret VALUES are ever returned, only where they
// were loaded from and how long they are.
const os = require("node:os");
const { Router } = require("express");
const db = require("../db");
const config = require("../config");
const { authenticate, requireRole, ROLES } = require("../middleware/auth");
const routeCatalog = require("../lib/routeCatalog");

const router = Router();
const startedAt = new Date();

const TABLES = ["stores", "users", "products", "stock", "transfers", "stock_movements"];

// Who can do what. Mirrors the checks in middleware/auth.js and services/inventory.js.
const PERMISSIONS = [
  { action: "View stock, products, low stock (both stores)", admin: true, manager: true, staff: true },
  { action: "Record a sale or restock",                      admin: "any store", manager: "own store", staff: "own store" },
  { action: "Stock adjustment (with reason)",                admin: "any store", manager: "own store", staff: false },
  { action: "Request a transfer",                            admin: true, manager: "own store involved", staff: "own store involved" },
  { action: "Dispatch a transfer",                           admin: true, manager: "source store", staff: false },
  { action: "Receive a transfer",                            admin: true, manager: "destination store", staff: "destination store" },
  { action: "Cancel a transfer",                             admin: true, manager: "either store", staff: false },
  { action: "Audit history",                                 admin: "all stores", manager: "own store", staff: "own store" },
  { action: "Users list, System page",                       admin: true, manager: false, staff: false },
];

router.get("/", authenticate, requireRole("admin"), async (req, res) => {
  // Database round-trip time, measured with the cheapest possible query.
  const t0 = process.hrtime.bigint();
  await db.query("SELECT 1");
  const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const [info, counts, integrity] = await Promise.all([
    db.query(`
      SELECT current_setting('server_version')             AS version,
             current_database()                            AS name,
             pg_database_size(current_database())          AS size_bytes,
             current_setting('max_connections')::int       AS max_connections,
             (SELECT count(*)::int FROM pg_stat_activity
               WHERE datname = current_database())          AS connections,
             extract(epoch FROM now() - pg_postmaster_start_time())::int AS server_uptime_s`),
    db.query(TABLES.map((t) => `SELECT '${t}' AS table, count(*)::int AS rows FROM ${t}`).join(" UNION ALL ")),
    db.query(`
      SELECT
        (SELECT count(*)::int FROM (
           SELECT 1 FROM stock s
             LEFT JOIN stock_movements m ON m.store_id = s.store_id AND m.product_id = s.product_id
            GROUP BY s.store_id, s.product_id, s.quantity
           HAVING s.quantity <> coalesce(sum(m.quantity_change), 0)) x)            AS mismatched,
        (SELECT count(*)::int FROM stock WHERE quantity < 0)                         AS negative,
        (SELECT count(*)::int FROM (
           SELECT 1 FROM transfers t
             LEFT JOIN stock_movements m ON m.transfer_id = t.id AND m.movement_type = 'transfer_in'
            WHERE t.status = 'received' GROUP BY t.id HAVING count(m.id) <> 1) y)     AS bad_receipts`),
  ]);

  const d = info.rows[0];
  const i = integrity.rows[0];
  const mem = process.memoryUsage();

  res.json({
    generatedAt: new Date().toISOString(),
    api: {
      instance: config.instance,
      environment: config.deployEnv,
      version: config.appVersion,
      gitSha: config.gitSha,
      node: process.version,
      platform: `${process.platform}/${process.arch}`, // arm64 on a Mac, amd64 on DigitalOcean
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: { rss: +(mem.rss / 1048576).toFixed(1), heapUsed: +(mem.heapUsed / 1048576).toFixed(1) },
      cpus: os.cpus().length,
    },
    kubernetes: {
      detected: Boolean(process.env.KUBERNETES_SERVICE_HOST),
      ...config.kubernetes,
    },
    database: {
      engine: "PostgreSQL",
      version: d.version,
      name: d.name,
      host: config.db.host,
      latencyMs: +latencyMs.toFixed(2),
      sizeMb: +(Number(d.size_bytes) / 1048576).toFixed(2),
      connections: { thisDatabase: d.connections, serverMax: d.max_connections },
      serverUptimeSeconds: d.server_uptime_s,
      pool: {
        max: config.db.poolMax,
        open: db.pool.totalCount,
        idle: db.pool.idleCount,
        waiting: db.pool.waitingCount,
      },
      tables: counts.rows,
    },
    integrity: [
      { check: "Stock equals the sum of its audit history", violations: i.mismatched, ok: i.mismatched === 0 },
      { check: "No negative stock",                         violations: i.negative,   ok: i.negative === 0 },
      { check: "Each received transfer has exactly one transfer_in", violations: i.bad_receipts, ok: i.bad_receipts === 0 },
    ],
    auth: {
      tokenType: "JWT (stateless, verified by any replica)",
      algorithm: "HS256",
      tokenLifetime: config.jwt.expiresIn,
      issuer: config.jwt.issuer,
      signingKey: { source: config.secretSources.JWT_SECRET, lengthChars: config.jwt.secret.length },
      databasePassword: { source: config.secretSources.DB_PASSWORD },
      passwordHashing: "bcrypt, cost factor 12",
      loginRateLimit: "10 failed attempts per 15 minutes per client IP",
      roles: ROLES,
      permissions: PERMISSIONS,
      yourToken: { userId: req.user.id, role: req.user.role, issuedAt: req.user.tokenIssuedAt, expiresAt: req.user.tokenExpiresAt },
    },
    routes: routeCatalog,
  });
});

module.exports = router;

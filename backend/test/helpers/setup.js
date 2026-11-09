// Test harness: an ISOLATED test database plus an in-process API server.
//
// Tests never touch your development data: they use a separate database
// (stocksync_test by default) inside the same PostgreSQL server, and wipe and
// re-seed it from database/init/*.sql before each test file.
//
// Defaults match the Docker Compose setup (PostgreSQL published on localhost:5433,
// password in secrets/db_password.txt). Override with DB_HOST, DB_PORT, DB_USER,
// DB_PASSWORD or DB_PASSWORD_FILE, and TEST_DB_NAME (used by CI later).
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../../..");
const passwordFile = path.join(repoRoot, "secrets/db_password.txt");

// --- Environment must be set BEFORE the app's config.js is loaded ----------
process.env.DB_HOST ??= "localhost";
process.env.DB_PORT ??= "5433";
process.env.DB_USER ??= "stocksync";
process.env.DB_NAME = process.env.TEST_DB_NAME || "stocksync_test";
if (!process.env.DB_PASSWORD && !process.env.DB_PASSWORD_FILE && fs.existsSync(passwordFile)) {
  process.env.DB_PASSWORD_FILE = passwordFile;
}
process.env.JWT_SECRET ??= "test-only-secret-that-is-long-enough-0123456789";
process.env.LOG_LEVEL ??= "silent";
process.env.DB_POOL_MAX ??= "10";

if (!process.env.DB_NAME.endsWith("_test")) {
  // Guard rail: this harness DROPS the schema. Never point it at real data.
  throw new Error(`Refusing to run tests against "${process.env.DB_NAME}": test database name must end with _test`);
}

const { Client } = require("pg");
const config = require("../../src/config");
const { createApp } = require("../../src/app");
const { pool } = require("../../src/db");

const SQL_FILES = ["01-schema.sql", "02-seed.sql"].map((f) => path.join(repoRoot, "database/init", f));
const PASSWORD = "StockSync!2026";

function clientFor(database) {
  return new Client({
    host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database,
  });
}

/** Create the test database if needed, then rebuild it from the schema and seed files. */
async function resetDatabase() {
  const admin = clientFor("postgres");
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [config.db.database]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${config.db.database}"`);
  }
  await admin.end();

  const client = clientFor(config.db.database);
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  for (const file of SQL_FILES) {
    await client.query(fs.readFileSync(file, "utf8"));
  }
  await client.end();
}

/** Start the API on a random free port. Returns { baseUrl, close }. */
async function startServer() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

/** Small HTTP client bound to a base URL. */
function apiClient(baseUrl) {
  async function call(method, urlPath, { token, body } = {}) {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  return {
    get: (p, opts) => call("GET", p, opts),
    post: (p, opts) => call("POST", p, opts),
    async login(email) {
      const res = await call("POST", "/api/auth/login", { body: { email, password: PASSWORD } });
      if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
      return res.body.token;
    },
  };
}

/** Direct SQL for assertions (bypasses the API on purpose). */
async function sql(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

async function quantity(storeCode, sku) {
  const rows = await sql(
    `SELECT s.quantity FROM stock s
       JOIN stores st ON st.id = s.store_id JOIN products p ON p.id = s.product_id
      WHERE st.code = $1 AND p.sku = $2`,
    [storeCode, sku],
  );
  return rows[0]?.quantity ?? 0;
}

async function ids(storeCode, sku) {
  const rows = await sql(
    `SELECT (SELECT id FROM stores WHERE code = $1) AS "storeId",
            (SELECT id FROM products WHERE sku = $2) AS "productId"`,
    [storeCode, sku],
  );
  return rows[0];
}

/**
 * The integrity checks from database/checks.sql. Each must return 0 rows.
 * Run at the end of every test file: whatever the tests did, the books must balance.
 */
async function integrityViolations() {
  const mismatched = await sql(`
    SELECT s.store_id, s.product_id, s.quantity, coalesce(sum(m.quantity_change), 0)::int AS audited
      FROM stock s
      LEFT JOIN stock_movements m ON m.store_id = s.store_id AND m.product_id = s.product_id
     GROUP BY s.store_id, s.product_id, s.quantity
    HAVING s.quantity <> coalesce(sum(m.quantity_change), 0)`);
  const negative = await sql(`SELECT * FROM stock WHERE quantity < 0`);
  const badReceipts = await sql(`
    SELECT t.id FROM transfers t
      LEFT JOIN stock_movements m ON m.transfer_id = t.id AND m.movement_type = 'transfer_in'
     WHERE t.status = 'received' GROUP BY t.id HAVING count(m.id) <> 1`);
  return { mismatched, negative, badReceipts };
}

module.exports = { resetDatabase, startServer, apiClient, sql, quantity, ids, integrityViolations, config };

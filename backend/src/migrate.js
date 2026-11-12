// =============================================================================
// Database migrations: numbered SQL files in backend/migrations/, applied once.
//
//   node src/migrate.js        apply pending migrations, then exit (0 = ok)
//
// How it works
//   * database/init/*.sql is the BASELINE (run by PostgreSQL itself on an empty
//     volume). Every change after that is a migration file: 001_..., 002_...
//   * The table schema_migrations records each applied file and its SHA-256.
//     A file runs at most once; editing an applied file is an error (write a new
//     migration instead), so every environment ends up with the same schema.
//   * Each file runs inside ONE transaction: it applies completely or not at all.
//   * A PostgreSQL advisory lock serialises runners, so several API pods starting
//     at once (Kubernetes init containers) cannot apply the same file twice.
//
// Where it runs: Kubernetes init container of every API pod (before the app
// starts), the "migrate" service in Docker Compose, and the test harness.
// =============================================================================
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const LOCK_KEY = 1779_2026; // any constant; identifies "the StockSync migration lock"

/** Migration files in order: { version, file, sql, checksum }. */
function migrationFiles(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      return {
        version: file.replace(/\.sql$/, ""),
        file,
        sql,
        checksum: crypto.createHash("sha256").update(sql).digest("hex"),
      };
    });
}

/**
 * Apply pending migrations using an already-connected pg Client.
 * Returns { applied: [versions], alreadyApplied: n }.
 */
async function migrate(client, { log = () => {}, dir } = {}) {
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT        PRIMARY KEY,
        checksum   TEXT        NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query("SELECT version, checksum FROM schema_migrations");
    const done = new Map(rows.map((r) => [r.version, r.checksum]));

    const applied = [];
    for (const m of migrationFiles(dir)) {
      if (done.has(m.version)) {
        if (done.get(m.version) !== m.checksum) {
          throw new Error(
            `Migration ${m.file} was changed after it was applied. ` +
              "Never edit an applied migration: add a new numbered file instead.",
          );
        }
        continue;
      }
      log(`applying ${m.file}`);
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
          m.version,
          m.checksum,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        err.message = `Migration ${m.file} failed and was rolled back: ${err.message}`;
        throw err;
      }
      applied.push(m.version);
    }
    return { applied, alreadyApplied: done.size };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
  }
}

// --- Command line -------------------------------------------------------------
// Reads only the database settings (not the JWT secret): a migration does not
// need, and should not get, more secrets than necessary.
function dbPassword() {
  if (process.env.DB_PASSWORD_FILE) return fs.readFileSync(process.env.DB_PASSWORD_FILE, "utf8").trim();
  if (process.env.DB_PASSWORD) return process.env.DB_PASSWORD;
  throw new Error("Set DB_PASSWORD or DB_PASSWORD_FILE");
}

async function main() {
  const { Client } = require("pg");
  const settings = {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "stocksync",
    database: process.env.DB_NAME || "stocksync",
    password: dbPassword(),
  };
  const log = (msg) => console.log(`${new Date().toISOString()} migrate: ${msg}`);

  // The database may still be starting (fresh cluster, Compose): retry ~60 s.
  let client;
  for (let attempt = 1; ; attempt++) {
    client = new Client(settings);
    try {
      await client.connect();
      break;
    } catch (err) {
      await client.end().catch(() => {});
      if (attempt >= 30) throw err;
      log(`database not reachable yet (${err.code || err.message}), retry ${attempt}/30`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  try {
    log(`connected to ${settings.database}@${settings.host}`);
    const { applied, alreadyApplied } = await migrate(client, { log });
    log(applied.length ? `applied ${applied.join(", ")}` : `up to date (${alreadyApplied} applied earlier)`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${new Date().toISOString()} migrate: FAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { migrate, migrationFiles };

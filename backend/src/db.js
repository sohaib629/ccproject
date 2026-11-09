// PostgreSQL connection pool plus a transaction helper.
const { Pool } = require("pg");
const config = require("./config");
const logger = require("./lib/logger");

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: `stocksync-api@${config.instance}`, // visible in pg_stat_activity
});

// An idle client can error if the database restarts (e.g. the postgres pod is
// rescheduled). Log it; the pool drops that client and opens a fresh one later.
pool.on("error", (err) => {
  logger.error({ err }, "idle PostgreSQL client error");
});

/**
 * Run `work(client)` inside a single database transaction.
 * Commits if `work` resolves, rolls back if it throws, and always releases the
 * client back to the pool. All stock changes and their audit rows go through
 * this, so they commit together or not at all.
 */
async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, "rollback failed");
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  withTransaction,
};

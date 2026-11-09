// Process entry point: start the HTTP server and shut down gracefully.
const config = require("./config");
const logger = require("./lib/logger");
const { pool } = require("./db");
const { createApp } = require("./app");

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, "StockSync API listening");
});

// Kubernetes sends SIGTERM before stopping a pod (rolling updates, scale-down).
// Stop accepting new connections, let in-flight requests (and their database
// transactions) finish, close the pool, then exit. This is why the Dockerfile
// runs `node` directly instead of `npm start`: npm does not forward SIGTERM.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");

  const forceExit = setTimeout(() => {
    logger.error("graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async () => {
    await pool.end();
    logger.info("shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Structured JSON logs to stdout. Kubernetes collects stdout, so these lines
// are what `kubectl logs` and `docker compose logs` show.
const pino = require("pino");
const config = require("../config");

const logger = pino({
  level: config.logLevel,
  base: { service: "stocksync-api", instance: config.instance },
  // Never log credentials or tokens, even by accident.
  redact: ["req.headers.authorization", "password", "*.password", "password_hash", "*.password_hash"],
});

module.exports = logger;

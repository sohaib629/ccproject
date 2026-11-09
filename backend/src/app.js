// Builds the Express app without starting a server, so tests can import it.
const express = require("express");
const helmet = require("helmet");
const pinoHttp = require("pino-http");
const crypto = require("node:crypto");
const config = require("./config");
const logger = require("./lib/logger");
const { AppError, fromPgError } = require("./lib/errors");

const healthRoutes = require("./routes/health");
const authRoutes = require("./routes/auth");
const storeRoutes = require("./routes/stores");
const userRoutes = require("./routes/users");

function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(helmet());
  app.use(express.json({ limit: "100kb" }));

  // One log line per request, with a request id that is also returned to the
  // client (X-Request-Id), so a user-reported error can be found in the logs.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = req.get("x-request-id") || crypto.randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      // Probes hit these every few seconds; keep them out of the logs.
      autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/ready" },
    }),
  );

  // Tells you which replica answered: useful when demonstrating load balancing.
  app.use((_req, res, next) => {
    res.setHeader("X-Instance", config.instance);
    next();
  });

  app.use(healthRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/stores", storeRoutes);
  app.use("/api/users", userRoutes);

  app.use((_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Route not found")));

  // Central error handler. Express 5 forwards errors from async handlers here
  // automatically, so routes can simply `throw`.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === "entity.parse.failed") {
      err = new AppError(400, "BAD_REQUEST", "Malformed JSON body");
    }
    const appErr = err instanceof AppError ? err : fromPgError(err);
    if (appErr) {
      return res.status(appErr.status).json({
        error: { code: appErr.code, message: appErr.message, details: appErr.details },
      });
    }
    // Unexpected: log everything, reveal nothing.
    req.log.error({ err }, "unhandled error");
    return res.status(500).json({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  return app;
}

module.exports = { createApp };

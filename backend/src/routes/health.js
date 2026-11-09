// Health endpoints for Docker and Kubernetes probes. Not under /api and no auth:
// probes come from the kubelet, not from users.
//
//   GET /health  liveness:  "is the process alive?"  Never touches the database,
//                so a database outage does not make Kubernetes restart every API pod.
//   GET /ready   readiness: "can this pod serve traffic right now?"  Checks the
//                database; while it fails, the Service stops routing to this pod.
const { Router } = require("express");
const db = require("../db");
const config = require("../config");

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", instance: config.instance });
});

router.get("/ready", async (_req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ status: "ready", instance: config.instance, database: "up" });
  } catch {
    res.status(503).json({ status: "not_ready", instance: config.instance, database: "down" });
  }
});

module.exports = router;

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

// Which build is running. Public on purpose: the commit is already public in
// the repository, and CD checks it to prove the new version is really live.
const build = { version: config.appVersion, commit: config.gitSha, deployedAt: config.deployedAt };

router.get("/health", (_req, res) => {
  res.json({ status: "ok", instance: config.instance, ...build });
});

async function readiness(_req, res) {
  try {
    await db.query("SELECT 1");
    res.json({ status: "ready", instance: config.instance, database: "up", ...build });
  } catch {
    res.status(503).json({ status: "not_ready", instance: config.instance, database: "down", ...build });
  }
}

router.get("/ready", readiness);

// Public end-to-end check through the load balancer and Gateway (which only
// route /api/* to the API). Used by the DigitalOcean uptime check: 200 means
// "DNS, TLS, Gateway, API and database are all working". No secrets returned.
router.get("/api/health", readiness);

module.exports = router;

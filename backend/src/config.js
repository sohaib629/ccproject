// Central configuration. Every setting comes from the environment, so the same
// image runs unchanged in Docker Compose, minikube and DigitalOcean Kubernetes.
//
// Secrets can be given directly (DB_PASSWORD=...) or as a path to a file
// (DB_PASSWORD_FILE=/run/secrets/db_password). The *_FILE form is what Docker
// secrets and Kubernetes Secret volumes provide, and it keeps secrets out of
// `docker inspect` / process listings.

const fs = require("node:fs");

// Where each secret was loaded from ("file" or "env"). Reported by /api/system;
// the secret values themselves are never exposed.
const secretSources = {};

function readSecret(name, { required = true } = {}) {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    secretSources[name] = "file";
    return fs.readFileSync(filePath, "utf8").trim();
  }
  const value = process.env[name];
  if (!value && required) {
    throw new Error(`Missing required secret: set ${name} or ${name}_FILE`);
  }
  secretSources[name] = "env";
  return value;
}

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

const jwtSecret = readSecret("JWT_SECRET");
if (jwtSecret.length < 32) {
  // A short HS256 key can be brute-forced; refuse to start rather than run insecurely.
  throw new Error("JWT_SECRET must be at least 32 characters");
}

const config = Object.freeze({
  env: process.env.NODE_ENV || "development",
  port: intFromEnv("PORT", 3000),
  logLevel: process.env.LOG_LEVEL || "info",
  db: Object.freeze({
    host: process.env.DB_HOST || "localhost",
    port: intFromEnv("DB_PORT", 5432),
    user: process.env.DB_USER || "stocksync",
    database: process.env.DB_NAME || "stocksync",
    password: readSecret("DB_PASSWORD"),
    // Each API replica keeps at most this many connections. With the HPA
    // maximum of 5 replicas: 5 x 10 = 50, safely below PostgreSQL's default
    // max_connections of 100.
    poolMax: intFromEnv("DB_POOL_MAX", 10),
  }),
  jwt: Object.freeze({
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN || "8h", // one working shift
    issuer: "stocksync-api",
  }),
  // Number of reverse proxies in front of the API (DigitalOcean LB + Gateway).
  // Needed so req.ip is the real client IP for login rate limiting.
  trustProxy: intFromEnv("TRUST_PROXY_HOPS", 0),
  // Identifies which replica answered; set from the pod name in Kubernetes.
  instance: process.env.HOSTNAME || "local",
  // Shown on the System page. DEPLOY_ENV: docker-compose | minikube | doks.
  deployEnv: process.env.DEPLOY_ENV || "local",
  appVersion: process.env.APP_VERSION || require("../package.json").version,
  // Build information, set by k8s/deploy.sh (and therefore by CD) on every
  // deploy: the git commit of the running image and when it was deployed.
  gitSha: process.env.GIT_SHA || "dev",
  deployedAt: process.env.DEPLOYED_AT || null,
  repoUrl: process.env.REPO_URL || "https://github.com/sohaib629/ccproject",
  // Filled in by the Kubernetes Downward API from Day 4 onwards (null before).
  kubernetes: Object.freeze({
    podName: process.env.POD_NAME || null,
    namespace: process.env.POD_NAMESPACE || null,
    nodeName: process.env.NODE_NAME || null,
    podIp: process.env.POD_IP || null,
  }),
  secretSources: Object.freeze({ ...secretSources }),
});

module.exports = config;

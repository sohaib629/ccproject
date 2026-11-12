// Authentication (who are you?) and authorization (are you allowed?).
const jwt = require("jsonwebtoken");
const config = require("../config");
const db = require("../db");
const { unauthorized, forbidden } = require("../lib/errors");

const ROLES = Object.freeze(["admin", "manager", "staff"]);

function signToken(user) {
  return jwt.sign(
    // tv = token version: bumped when the password is reset or the account is
    // deactivated, which invalidates every token issued before.
    { role: user.role, storeId: user.store_id, name: user.full_name, tv: user.token_version ?? 0 },
    config.jwt.secret,
    {
      subject: String(user.id),
      expiresIn: config.jwt.expiresIn,
      issuer: config.jwt.issuer,
      algorithm: "HS256",
    },
  );
}

/**
 * Require a valid "Authorization: Bearer <token>" header.
 * On success, req.user = { id, role, storeId, name, ... }.
 *
 * The signature check needs no shared state, so any API replica can verify any
 * token. One indexed lookup then confirms the account is still active and the
 * token is not older than the last password reset, so deactivating a user or
 * resetting a password takes effect immediately on every replica. Role and store
 * come from that fresh row, not from the (possibly outdated) token.
 */
async function authenticate(req, _res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return next(unauthorized());
  }
  let claims;
  try {
    claims = jwt.verify(token, config.jwt.secret, {
      algorithms: ["HS256"], // pin the algorithm: rejects "alg: none" and key-confusion tricks
      issuer: config.jwt.issuer,
    });
  } catch {
    return next(unauthorized("Invalid or expired token"));
  }
  const { rows } = await db.query(
    `SELECT role, store_id, full_name, is_active, token_version FROM users WHERE id = $1`,
    [Number(claims.sub)],
  );
  const account = rows[0];
  if (!account || !account.is_active || account.token_version !== (claims.tv ?? 0)) {
    return next(unauthorized("Session is no longer valid, please log in again"));
  }
  req.user = {
    id: Number(claims.sub),
    role: account.role,
    storeId: account.store_id ?? null,
    name: account.full_name,
    tokenIssuedAt: new Date(claims.iat * 1000).toISOString(),
    tokenExpiresAt: new Date(claims.exp * 1000).toISOString(),
  };
  return next();
}

/**
 * Allow only the listed roles. Must run after authenticate.
 * Example: router.post("/transfers/:id/dispatch", requireRole("manager", "admin"), handler)
 */
function requireRole(...allowed) {
  for (const role of allowed) {
    if (!ROLES.includes(role)) throw new Error(`Unknown role "${role}"`);
  }
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!allowed.includes(req.user.role)) {
      return next(forbidden(`Requires role: ${allowed.join(" or ")}`));
    }
    return next();
  };
}

/**
 * Store scoping: managers and staff may only act on their own store; admins on any.
 * Used by Day 2 routes, e.g. a Downtown staff member cannot record a North York sale.
 */
function canActOnStore(user, storeId) {
  return user.role === "admin" || user.storeId === Number(storeId);
}

module.exports = { ROLES, signToken, authenticate, requireRole, canActOnStore };

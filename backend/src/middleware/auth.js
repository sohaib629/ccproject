// Authentication (who are you?) and authorization (are you allowed?).
const jwt = require("jsonwebtoken");
const config = require("../config");
const { unauthorized, forbidden } = require("../lib/errors");

const ROLES = Object.freeze(["admin", "manager", "staff"]);

function signToken(user) {
  return jwt.sign(
    { role: user.role, storeId: user.store_id, name: user.full_name },
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
 * On success, req.user = { id, role, storeId, name }.
 * The token is self-contained, so any API replica can verify it without shared
 * session state; that is what keeps the API stateless and horizontally scalable.
 */
function authenticate(req, _res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return next(unauthorized());
  }
  try {
    const claims = jwt.verify(token, config.jwt.secret, {
      algorithms: ["HS256"], // pin the algorithm: rejects "alg: none" and key-confusion tricks
      issuer: config.jwt.issuer,
    });
    req.user = {
      id: Number(claims.sub),
      role: claims.role,
      storeId: claims.storeId ?? null,
      name: claims.name,
      tokenIssuedAt: new Date(claims.iat * 1000).toISOString(),
      tokenExpiresAt: new Date(claims.exp * 1000).toISOString(),
    };
    return next();
  } catch {
    return next(unauthorized("Invalid or expired token"));
  }
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

const { Router } = require("express");
const bcrypt = require("bcryptjs");
const { rateLimit } = require("express-rate-limit");
const { z } = require("zod");
const db = require("../db");
const { signToken, authenticate } = require("../middleware/auth");
const { parse } = require("../lib/validate");
const { unauthorized, notFound } = require("../lib/errors");

const router = Router();

// Slow down password guessing: 10 FAILED attempts per 15 minutes per client IP
// (successful logins are not counted).
// Limitation: counters live in each replica's memory, so with N replicas an
// attacker gets up to N x 10 attempts. A shared store (e.g. Redis) would fix it.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  // Count only WRONG CREDENTIALS (401). Without this, any non-2xx answer
  // (a 503 from an overloaded pod, a 400 typo, or the 429s themselves) also
  // counted, so a burst of server errors could lock real users out for 15 min.
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "TOO_MANY_ATTEMPTS", message: "Too many login attempts, try again later" } },
});

const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});

// Compared against when the email does not exist, so a wrong email and a wrong
// password take the same time and an attacker cannot discover valid emails.
const DUMMY_HASH = bcrypt.hashSync("timing-equaliser-not-a-real-password", 12);

// POST /api/auth/login  { email, password }  ->  { token, user }
router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = parse(loginSchema, req.body);

  const { rows } = await db.query(
    `SELECT u.id, u.email, u.full_name, u.password_hash, u.role, u.store_id, u.is_active,
            s.code AS store_code, s.name AS store_name
       FROM users u
       LEFT JOIN stores s ON s.id = u.store_id
      WHERE lower(u.email) = lower($1)`,
    [email],
  );
  const user = rows[0];

  const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk || !user.is_active) {
    // One generic message for every failure: do not reveal which part was wrong.
    req.log.warn({ email }, "login failed");
    throw unauthorized("Invalid email or password");
  }

  req.log.info({ userId: user.id, role: user.role }, "login succeeded");
  res.json({ token: signToken(user), user: toPublicUser(user) });
});

// GET /api/auth/me  ->  the logged-in user's profile (fresh from the database)
router.get("/me", authenticate, async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.full_name, u.role, u.store_id, u.is_active,
            s.code AS store_code, s.name AS store_name
       FROM users u
       LEFT JOIN stores s ON s.id = u.store_id
      WHERE u.id = $1`,
    [req.user.id],
  );
  if (!rows[0] || !rows[0].is_active) throw notFound("User not found");
  res.json({ user: toPublicUser(rows[0]) });
});

function toPublicUser(u) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.full_name,
    role: u.role,
    store: u.store_id ? { id: u.store_id, code: u.store_code, name: u.store_name } : null,
  };
}

module.exports = router;

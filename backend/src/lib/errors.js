// Application errors carry an HTTP status and a stable machine-readable code,
// so the frontend and tests can react to `code` instead of parsing messages.
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, "BAD_REQUEST", message, details);
const unauthorized = (message = "Authentication required") => new AppError(401, "UNAUTHORIZED", message);
const forbidden = (message = "You do not have permission to do this") => new AppError(403, "FORBIDDEN", message);
const notFound = (message = "Not found") => new AppError(404, "NOT_FOUND", message);
const conflict = (code, message, details) => new AppError(409, code, message, details);

// PostgreSQL error codes we translate into client errors.
// https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG = Object.freeze({
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  CHECK_VIOLATION: "23514",
});

/** Map a PostgreSQL error to an AppError, or return null if it is not a client error. */
function fromPgError(err) {
  switch (err.code) {
    case PG.UNIQUE_VIOLATION:
      return conflict("ALREADY_EXISTS", "A record with these values already exists", { constraint: err.constraint });
    case PG.FOREIGN_KEY_VIOLATION:
      return badRequest("Referenced record does not exist", { constraint: err.constraint });
    case PG.CHECK_VIOLATION:
      // Reaching this means the API's own checks missed something and the
      // database stopped it: the last line of defence worked.
      return conflict("CONSTRAINT_VIOLATION", "The change would break a data integrity rule", {
        constraint: err.constraint,
      });
    default:
      return null;
  }
}

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, fromPgError, PG };

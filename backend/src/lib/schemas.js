// Reusable validation rules shared by the routes.
const { z } = require("zod");

// IDs arrive as JSON numbers or as URL/query strings: accept both, require a positive integer.
const id = z.coerce.number().int().positive();

// Units per single operation. The upper bound stops typos like 10000 instead of 10.
const quantity = z.coerce.number().int().positive().max(1000);

const optionalText = z.string().trim().min(1).max(500).optional();

const requiredReason = z.string().trim().min(3, "A reason of at least 3 characters is required").max(500);

module.exports = { z, id, quantity, optionalText, requiredReason };

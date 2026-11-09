// Request validation with zod. Invalid input never reaches SQL.
const { badRequest } = require("./errors");

/** Parse `data` with `schema`; throw a 400 listing every invalid field. */
function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => ({
      field: issue.path.join(".") || "(body)",
      message: issue.message,
    }));
    throw badRequest("Invalid request", { fields });
  }
  return result.data;
}

module.exports = { parse };

// Append one row to admin_audit (migration 003): who changed which product or
// account, when, and what changed. Call inside the same transaction as the change.
async function recordAdminChange(client, { entity, entityId, action, changes = {}, userId }) {
  await client.query(
    `INSERT INTO admin_audit (entity, entity_id, action, changes, user_id) VALUES ($1, $2, $3, $4, $5)`,
    [entity, entityId, action, JSON.stringify(changes), userId],
  );
}

/** Audit rows for one product or account, newest first, with the admin's name. */
async function adminHistory(dbOrClient, entity, entityId) {
  const { rows } = await dbOrClient.query(
    `SELECT a.id, a.action, a.changes, a.created_at AS "createdAt", u.full_name AS "byName"
       FROM admin_audit a JOIN users u ON u.id = a.user_id
      WHERE a.entity = $1 AND a.entity_id = $2
      ORDER BY a.id DESC`,
    [entity, entityId],
  );
  return rows;
}

/** {field: {from, to}} for every field whose value actually changes. */
function diff(before, after) {
  const changes = {};
  for (const [key, to] of Object.entries(after)) {
    if (to !== undefined && before[key] !== to) changes[key] = { from: before[key], to };
  }
  return changes;
}

module.exports = { recordAdminChange, adminHistory, diff };

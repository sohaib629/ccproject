#!/usr/bin/env bash
# =============================================================================
# Restore test: prove the latest backup can actually be restored.
#
#   1. download the newest dump (or BACKUP_NAME=stocksync-<timestamp>) and its manifest
#   2. restore it into a SEPARATE database, $RESTORE_DB (default stocksync_restore),
#      on the same server; the live database "stocksync" is only read, never written
#   3. compare the restored row counts and checksums with the manifest recorded
#      at backup time, and run the integrity checks from database/checks.sql
#   4. drop the restore database (KEEP_RESTORE_DB=true keeps it for inspection)
# Exit code 0 only if every check passes.
# =============================================================================
set -euo pipefail
source "$(dirname "$0")/backup-common.sh"

RESTORE_DB="${RESTORE_DB:-stocksync_restore}"
[[ "$RESTORE_DB" != "$PGDATABASE" ]] || { echo "RESTORE_DB must differ from the live database"; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0
check() { # check <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then echo "  PASS  $1 ($3)"; pass=$((pass+1));
  else echo "  FAIL  $1 (backup: $2, restored: $3)"; fail=$((fail+1)); fi
}
q() { PGOPTIONS="-c client_min_messages=warning" psql -X -q -At -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }

# 1) Pick and download the backup.
if [[ -n "${BACKUP_NAME:-}" ]]; then NAME="${BACKUP_NAME%.dump}"
else NAME="$(list_dumps | tail -n 1)"; NAME="${NAME%.dump}"; fi
[[ -n "$NAME" ]] || { echo "No backups found in s3://$S3_BUCKET/$S3_PREFIX/"; exit 1; }
log "Restore test of $NAME"
s3 cp "s3://$S3_BUCKET/$S3_PREFIX/$NAME.dump" "$WORK/" --only-show-errors
s3 cp "s3://$S3_BUCKET/$S3_PREFIX/$NAME.json" "$WORK/" --only-show-errors
log "Downloaded $(du -h "$WORK/$NAME.dump" | cut -f1) dump and its manifest"

# 2) Restore into a fresh, separate database.
q postgres "DROP DATABASE IF EXISTS \"$RESTORE_DB\" WITH (FORCE)"
q postgres "CREATE DATABASE \"$RESTORE_DB\""
pg_restore --exit-on-error --no-owner --dbname="$RESTORE_DB" "$WORK/$NAME.dump"
log "Restored into database '$RESTORE_DB'"

# 3a) Counts and checksums must equal the manifest recorded at backup time.
expected="$WORK/$NAME.json"
actual="$(manifest_json "$RESTORE_DB")"
echo "Comparing restored data with the backup manifest:"
for key in stores users products stock_rows units_in_stock transfers \
           stock_movements last_movement_id products_md5 movements_md5; do
  exp="$(grep -o "\"$key\" *: *[^,}]*" "$expected" | head -1 | sed 's/.*: *//; s/"//g')"
  act="$(grep -o "\"$key\" *: *[^,}]*" <<<"$actual" | head -1 | sed 's/.*: *//; s/"//g')"
  check "$key" "$exp" "$act"
done

# 3b) Integrity checks (same rules as database/checks.sql): all must be 0.
echo "Integrity checks on the restored database:"
check "stock rows that differ from the audit history" 0 "$(q "$RESTORE_DB" "
  SELECT count(*) FROM (
    SELECT s.store_id, s.product_id FROM stock s
    LEFT JOIN stock_movements m ON m.store_id = s.store_id AND m.product_id = s.product_id
    GROUP BY s.store_id, s.product_id, s.quantity
    HAVING s.quantity <> coalesce(sum(m.quantity_change), 0)) x")"
check "negative stock rows" 0 "$(q "$RESTORE_DB" "SELECT count(*) FROM stock WHERE quantity < 0")"
check "received transfers without exactly one transfer_in" 0 "$(q "$RESTORE_DB" "
  SELECT count(*) FROM (
    SELECT t.id FROM transfers t
    LEFT JOIN stock_movements m ON m.transfer_id = t.id AND m.movement_type = 'transfer_in'
    WHERE t.status = 'received' GROUP BY t.id HAVING count(m.id) <> 1) x")"
check "audit trigger restored (history is append-only)" 1 "$(q "$RESTORE_DB" "
  SELECT count(*) FROM pg_trigger WHERE tgname = 'stock_movements_append_only'")"

# Information only: how far the live database has moved on since the backup.
live_moves="$(q "$PGDATABASE" "SELECT count(*) FROM stock_movements")"
echo "Info: the live database now has $live_moves audit rows (it was not modified)."

# 4) Clean up.
if [[ "${KEEP_RESTORE_DB:-false}" != "true" ]]; then
  q postgres "DROP DATABASE \"$RESTORE_DB\" WITH (FORCE)"
  log "Dropped '$RESTORE_DB'"
fi

echo "Result: $pass passed, $fail failed"
[[ $fail -eq 0 ]]

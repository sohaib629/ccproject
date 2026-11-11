#!/usr/bin/env bash
# =============================================================================
# Nightly backup: pg_dump -> DigitalOcean Spaces, keep the newest $KEEP.
#
# Writes two objects per run:
#   <prefix>/stocksync-<UTC timestamp>.dump   pg_dump custom format (compressed)
#   <prefix>/stocksync-<UTC timestamp>.json   manifest: row counts + checksums,
#                                             used by restore-test.sh to verify
# Credentials are files mounted from Kubernetes Secrets, never env literals:
#   /run/secrets/db_password            database password
#   /run/secrets/spaces/access_key      Spaces key limited to the backup bucket
#   /run/secrets/spaces/secret_key
# =============================================================================
set -euo pipefail
source "$(dirname "$0")/backup-common.sh"

KEEP="${KEEP:-7}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="stocksync-$STAMP"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

log "Backing up database '$PGDATABASE' on $PGHOST to s3://$S3_BUCKET/$S3_PREFIX/"

# 1) Dump. Custom format (-Fc) is compressed and lets pg_restore verify and
#    restore selectively. pg_dump reads one consistent snapshot of the database.
pg_dump --format=custom --compress=6 --no-owner --file="$WORK/$NAME.dump"
log "Dump written: $(du -h "$WORK/$NAME.dump" | cut -f1)"

# 2) Sanity check: the archive must be readable before it is uploaded.
pg_restore --list "$WORK/$NAME.dump" > /dev/null
log "Archive table of contents is readable"

# 3) Manifest: what the restore must reproduce (taken right after the dump).
manifest_json "$PGDATABASE" "$STAMP" > "$WORK/$NAME.json"
log "Manifest: $(cat "$WORK/$NAME.json")"

# 4) Upload both objects.
s3 cp "$WORK/$NAME.dump" "s3://$S3_BUCKET/$S3_PREFIX/$NAME.dump" --only-show-errors
s3 cp "$WORK/$NAME.json" "s3://$S3_BUCKET/$S3_PREFIX/$NAME.json" --only-show-errors \
   --content-type application/json
log "Uploaded $NAME.dump and $NAME.json"

# 5) Retention: keep the newest $KEEP dumps (names sort by timestamp).
mapfile -t dumps < <(list_dumps)
excess=$(( ${#dumps[@]} - KEEP ))
for (( i = 0; i < excess; i++ )); do
  old="${dumps[$i]%.dump}"
  s3 rm "s3://$S3_BUCKET/$S3_PREFIX/$old.dump" --only-show-errors
  s3 rm "s3://$S3_BUCKET/$S3_PREFIX/$old.json" --only-show-errors || true
  log "Retention: deleted $old"
done
log "Done. $(( ${#dumps[@]} - (excess > 0 ? excess : 0) )) backup(s) kept (limit $KEEP)."

#!/usr/bin/env bash
# Shared settings and helpers for backup.sh and restore-test.sh.

: "${PGHOST:=postgres}" "${PGPORT:=5432}" "${PGUSER:=stocksync}" "${PGDATABASE:=stocksync}"
: "${S3_ENDPOINT:?set S3_ENDPOINT, e.g. https://nyc3.digitaloceanspaces.com}"
: "${S3_BUCKET:?set S3_BUCKET to the Spaces bucket name}"
: "${S3_PREFIX:=postgres}"
export PGHOST PGPORT PGUSER PGDATABASE

secret() { # secret <file>: read a mounted secret file, without a trailing newline
  [[ -r "$1" ]] || { echo "Missing secret file $1" >&2; exit 1; }
  tr -d '\r\n' < "$1"
}

PGPASSWORD="$(secret "${DB_PASSWORD_FILE:-/run/secrets/db_password}")"
AWS_ACCESS_KEY_ID="$(secret "${SPACES_KEY_FILE:-/run/secrets/spaces/access_key}")"
AWS_SECRET_ACCESS_KEY="$(secret "${SPACES_SECRET_FILE:-/run/secrets/spaces/secret_key}")"
# Spaces ignores the region, but the AWS CLI requires one. The two checksum
# settings keep newer AWS CLI versions compatible with S3-compatible services.
export PGPASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export AWS_DEFAULT_REGION=us-east-1
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

log() { echo "$(date -u +%FT%TZ) $*"; }
s3()  { aws --endpoint-url "$S3_ENDPOINT" s3 "$@"; }

list_dumps() { # backup file names, oldest first (timestamps sort lexically)
  s3 ls "s3://$S3_BUCKET/$S3_PREFIX/" | awk '{print $4}' | grep -E '^stocksync-.*\.dump$' | sort || true
}

# The facts a restore must reproduce: row counts, total units in stock, the
# newest audit row, and checksums over the catalogue and the full audit history.
manifest_sql() {
  cat <<'SQL'
SELECT json_build_object(
  'stores',            (SELECT count(*) FROM stores),
  'users',             (SELECT count(*) FROM users),
  'products',          (SELECT count(*) FROM products),
  'stock_rows',        (SELECT count(*) FROM stock),
  'units_in_stock',    (SELECT coalesce(sum(quantity), 0) FROM stock),
  'transfers',         (SELECT count(*) FROM transfers),
  'stock_movements',   (SELECT count(*) FROM stock_movements),
  'last_movement_id',  (SELECT coalesce(max(id), 0) FROM stock_movements),
  'products_md5',      (SELECT md5(coalesce(string_agg(
                          concat_ws('|', sku, name, category, price_cents, reorder_threshold),
                          ',' ORDER BY sku), '')) FROM products),
  'movements_md5',     (SELECT md5(coalesce(string_agg(
                          concat_ws('|', id, store_id, product_id, movement_type, quantity_change, quantity_after),
                          ',' ORDER BY id), '')) FROM stock_movements)
)
SQL
}

manifest_json() { # manifest_json <database> [taken_at]
  local facts
  facts="$(manifest_sql | psql -X -q -At -v ON_ERROR_STOP=1 -d "$1")"
  if [[ -n "${2:-}" ]]; then
    printf '{"taken_at":"%s","database":"%s","facts":%s}\n' "$2" "$1" "$facts"
  else
    printf '%s\n' "$facts"
  fi
}

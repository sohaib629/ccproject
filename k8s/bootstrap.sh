#!/usr/bin/env bash
# =============================================================================
# Creates the two objects that must NOT live in git as plain YAML:
#   * Secret  stocksync-secrets  from secrets/db_password.txt and secrets/jwt_secret.txt
#   * ConfigMap db-init-sql      from database/init/*.sql (single source of truth
#                                shared with Docker Compose)
# Safe to re-run: uses "apply", so it creates or updates.
#
# Usage:  ./k8s/bootstrap.sh            (uses the current kubectl context)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

NS=stocksync
for f in secrets/db_password.txt secrets/jwt_secret.txt; do
  [[ -s "$f" ]] || { echo "Missing $f (see secrets/README.md)"; exit 1; }
done

echo "Context: $(kubectl config current-context)   Namespace: $NS"
kubectl apply -f k8s/base/namespace.yaml

kubectl -n "$NS" create secret generic stocksync-secrets \
  --from-file=db_password=secrets/db_password.txt \
  --from-file=jwt_secret=secrets/jwt_secret.txt \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NS" create configmap db-init-sql \
  --from-file=database/init \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secret and init-SQL ConfigMap are in place."

#!/usr/bin/env bash
# =============================================================================
# Creates the two objects that must NOT live in git as plain YAML:
#   * Secret  stocksync-secrets  from secrets/db_password.txt and secrets/jwt_secret.txt
#   * ConfigMap db-init-sql      from database/init/*.sql (single source of truth
#                                shared with Docker Compose)
#   * (doks) Secret docr                registry pull credentials (doctl)
#   * (doks) Secret spaces-credentials  Spaces key for backups, from
#                                       secrets/spaces_access_key.txt + spaces_secret_key.txt
# Safe to re-run: uses "apply", so it creates or updates.
#
# Usage:  ./k8s/bootstrap.sh            minikube (uses the current kubectl context)
#         ./k8s/bootstrap.sh doks       also creates the registry pull Secret "docr"
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

# On DigitalOcean: pull credentials for the private container registry.
if [[ "${1:-}" == "doks" ]]; then
  doctl registry kubernetes-manifest --namespace "$NS" --name docr | kubectl apply -f -

  # Spaces access key for the backup CronJob (limited to the backup bucket).
  if [[ -s secrets/spaces_access_key.txt && -s secrets/spaces_secret_key.txt ]]; then
    kubectl -n "$NS" create secret generic spaces-credentials \
      --from-file=access_key=secrets/spaces_access_key.txt \
      --from-file=secret_key=secrets/spaces_secret_key.txt \
      --dry-run=client -o yaml | kubectl apply -f -
  else
    echo "WARNING: secrets/spaces_access_key.txt or spaces_secret_key.txt missing;"
    echo "         backups will fail until they exist and this script is re-run."
  fi
fi

echo "Secrets and init-SQL ConfigMap are in place."

#!/usr/bin/env bash
# =============================================================================
# Deploy an overlay with explicit image versions.
#
#   ./k8s/deploy.sh minikube                 # local images stocksync-*:dev
#   DOCR_REGISTRY=<name> ./k8s/deploy.sh doks [TAG]
#       images: registry.digitalocean.com/<name>/stocksync-{api,frontend,backup}:TAG
#       TAG defaults to the current git commit (short SHA)
#
# Renders the overlay through a temporary kustomization that pins the images,
# applies it, and waits for every rollout. Used by hand and by CD
# (.github/workflows/cd.yml), so both deploy exactly the same way.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

OVERLAY="${1:?usage: deploy.sh <minikube|doks> [tag]}"
OVERLAY_DIR="$PWD/k8s/overlays/$OVERLAY"
[[ -d "$OVERLAY_DIR" ]] || { echo "No such overlay: $OVERLAY"; exit 1; }

if [[ "$OVERLAY" == "minikube" ]]; then
  API_IMAGE=stocksync-api FRONTEND_IMAGE=stocksync-frontend BACKUP_IMAGE=stocksync-backup
  TAG="${2:-dev}"
else
  : "${DOCR_REGISTRY:?set DOCR_REGISTRY to your registry name}"
  API_IMAGE="registry.digitalocean.com/$DOCR_REGISTRY/stocksync-api"
  FRONTEND_IMAGE="registry.digitalocean.com/$DOCR_REGISTRY/stocksync-frontend"
  BACKUP_IMAGE="registry.digitalocean.com/$DOCR_REGISTRY/stocksync-backup"
  TAG="${2:-$(git rev-parse --short HEAD)}"
fi

echo "Context:  $(kubectl config current-context)"
echo "Overlay:  $OVERLAY"
echo "Images:   $API_IMAGE:$TAG"
echo "          $FRONTEND_IMAGE:$TAG"
[[ "$OVERLAY" == "minikube" ]] || echo "          $BACKUP_IMAGE:$TAG"

# The temporary kustomization lives inside k8s/ (git-ignored), next to the
# overlays, so the overlay is simply "../overlays/<name>". (A system temp dir
# breaks on macOS: /var is a symlink to /private/var, and kustomize resolves the
# symlink before applying the relative path.)
TMP="$(mktemp -d "$PWD/k8s/.deploy.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
REL="../overlays/$OVERLAY"
cat > "$TMP/kustomization.yaml" <<YAML
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - $REL
images:
  - name: stocksync-api
    newName: $API_IMAGE
    newTag: "$TAG"
  - name: stocksync-frontend
    newName: $FRONTEND_IMAGE
    newTag: "$TAG"
  - name: stocksync-backup
    newName: $BACKUP_IMAGE
    newTag: "$TAG"
YAML

kubectl apply -k "$TMP"
kubectl -n stocksync rollout status statefulset/postgres --timeout=180s
kubectl -n stocksync rollout status deployment/api --timeout=180s
kubectl -n stocksync rollout status deployment/frontend --timeout=180s
echo "Deployed $OVERLAY at $TAG"

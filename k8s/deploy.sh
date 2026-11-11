#!/usr/bin/env bash
# =============================================================================
# Deploy an overlay with explicit image versions.
#
#   ./k8s/deploy.sh minikube                 # local images stocksync-*:dev
#   DOCR_REGISTRY=<name> ./k8s/deploy.sh doks [TAG]
#       images: registry.digitalocean.com/<name>/stocksync-{api,frontend}:TAG
#       TAG defaults to the current git commit (short SHA)
#
# Renders the overlay through a temporary kustomization that pins the images,
# applies it, and waits for every rollout. Used by hand today and by CD (Day 6).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

OVERLAY="${1:?usage: deploy.sh <minikube|doks> [tag]}"
OVERLAY_DIR="$PWD/k8s/overlays/$OVERLAY"
[[ -d "$OVERLAY_DIR" ]] || { echo "No such overlay: $OVERLAY"; exit 1; }

if [[ "$OVERLAY" == "minikube" ]]; then
  API_IMAGE=stocksync-api FRONTEND_IMAGE=stocksync-frontend TAG="${2:-dev}"
else
  : "${DOCR_REGISTRY:?set DOCR_REGISTRY to your registry name}"
  API_IMAGE="registry.digitalocean.com/$DOCR_REGISTRY/stocksync-api"
  FRONTEND_IMAGE="registry.digitalocean.com/$DOCR_REGISTRY/stocksync-frontend"
  TAG="${2:-$(git rev-parse --short HEAD)}"
fi

echo "Context:  $(kubectl config current-context)"
echo "Overlay:  $OVERLAY"
echo "Images:   $API_IMAGE:$TAG"
echo "          $FRONTEND_IMAGE:$TAG"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# kustomize resolves resources relative to the kustomization file, so point at
# the overlay with a relative path from the temporary directory.
REL="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$OVERLAY_DIR" "$TMP")"
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
YAML

kubectl apply -k "$TMP"
kubectl -n stocksync rollout status statefulset/postgres --timeout=180s
kubectl -n stocksync rollout status deployment/api --timeout=180s
kubectl -n stocksync rollout status deployment/frontend --timeout=180s
echo "Deployed $OVERLAY at $TAG"

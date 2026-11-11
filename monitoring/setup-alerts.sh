#!/usr/bin/env bash
# =============================================================================
# DigitalOcean monitoring for StockSync (run once after the cluster exists).
#
#   ALERT_EMAIL=you@example.com ./monitoring/setup-alerts.sh [cluster-name]
#
# Creates:
#   1. Resource alerts on every DOKS worker node (CPU, memory, disk). They target
#      the tag "k8s:<cluster-id>" that DOKS puts on its nodes, so nodes that are
#      replaced or added later are covered automatically.
#   2. An external uptime check of https://stocksync.online/api/health from
#      several regions (DNS + TLS + load balancer + Gateway + API + database),
#      with alerts when it is down and when the TLS certificate is about to expire.
#
# Notifications go to ALERT_EMAIL. The address must be verified in your
# DigitalOcean account (Settings -> Notifications) to receive alerts.
# Running the script twice creates duplicates; list with
#   doctl monitoring alert list   /   doctl monitoring uptime list
# =============================================================================
set -euo pipefail

: "${ALERT_EMAIL:?set ALERT_EMAIL to the address that should receive alerts}"
CLUSTER="${1:-stocksync}"
URL="${HEALTH_URL:-https://stocksync.online/api/health}"

CLUSTER_ID="$(doctl kubernetes cluster get "$CLUSTER" --format ID --no-header)"
TAG="k8s:${CLUSTER_ID}"
echo "Cluster $CLUSTER ($CLUSTER_ID); node tag $TAG"

create_node_alert() { # type threshold description
  doctl monitoring alert create \
    --type "$1" --compare GreaterThan --value "$2" --window 5m \
    --tags "$TAG" --emails "$ALERT_EMAIL" \
    --description "StockSync: $3" --format UUID,Type,Description
}

create_node_alert v1/insights/droplet/cpu                        80 "node CPU above 80% for 5 min"
create_node_alert v1/insights/droplet/memory_utilization_percent 85 "node memory above 85% for 5 min"
create_node_alert v1/insights/droplet/disk_utilization_percent   80 "node disk above 80% for 5 min"

CHECK_ID="$(doctl monitoring uptime create stocksync-https \
  --target "$URL" --type https --regions us_east,us_west,eu_west \
  --format ID --no-header)"
echo "Uptime check $CHECK_ID -> $URL"

doctl monitoring uptime alert create "$CHECK_ID" \
  --name "StockSync is down" --type down --period 2m \
  --emails "$ALERT_EMAIL" --format ID,Name,Type
doctl monitoring uptime alert create "$CHECK_ID" \
  --name "StockSync TLS certificate expires in < 14 days" --type ssl_expiry \
  --threshold 14 --comparison less_than --period 2m \
  --emails "$ALERT_EMAIL" --format ID,Name,Type

echo "Done. View them in the control panel: Monitoring -> Resource Alerts, and Monitoring -> Uptime."

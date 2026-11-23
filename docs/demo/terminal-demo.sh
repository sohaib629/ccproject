#!/usr/bin/env bash
# =============================================================================
# StockSync terminal demo (video, clip 2) – DigitalOcean Kubernetes (DOKS)
#
#   ./terminal-demo.sh           pauses after every step: press Enter to go on
#   AUTO=1 ./terminal-demo.sh    runs straight through without pauses
#
# Part 1 (steps 1-9): read-only checks – nothing is changed.
# Part 2 (steps 10-12): a rolling restart of the API (zero downtime; same
#                       image, no new commit), shown at the end.
# =============================================================================
set -u
NS=stocksync
SITE=https://stocksync.online

BOLD=$'\033[1m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
LINE="════════════════════════════════════════════════════════════════════"
step=0

section() {   # section "Title" "What this step shows"
  step=$((step + 1))
  clear
  printf '%s\n' "${CYAN}${BOLD}${LINE}${RESET}"
  printf '%s\n' "${CYAN}${BOLD}  Step ${step} · $1${RESET}"
  printf '%s\n' "${DIM}  $2${RESET}"
  printf '%s\n\n' "${CYAN}${BOLD}${LINE}${RESET}"
}

run() {       # run "command" – prints the command, then runs it
  printf '%s\n' "${YELLOW}\$ $1${RESET}"
  eval "$1"
  echo
}

end_step() {
  printf '%s\n' "${GREEN}✔ End of step ${step}${RESET}"
  if [ -z "${AUTO:-}" ]; then
    read -r -p "  Press Enter for the next step… " _
  fi
}

# --------------------------------------------------------------------------- #
# Part 1 – what is running (read-only)
# --------------------------------------------------------------------------- #
section "Connected to DigitalOcean Kubernetes" \
        "kubectl talks to our DOKS cluster: 2 worker nodes, both Ready"
run "kubectl config current-context"
run "kubectl get nodes"
end_step

section "Running pods, nodes, containers and images" \
        "API and frontend: 2 replicas each, one per node · images tagged with the git commit"
run "kubectl -n $NS get pods \\
  -o custom-columns=POD:.metadata.name,NODE:.spec.nodeName,CONTAINER:.spec.containers[*].name,IMAGE:.spec.containers[*].image \\
  --field-selector=status.phase=Running"
end_step

section "Job containers (finished)" \
        "Nightly backups (03:00) and the backup CD takes before every deploy"
run "kubectl -n $NS get pods \\
  -o custom-columns=POD:.metadata.name,NODE:.spec.nodeName,CONTAINER:.spec.containers[*].name,IMAGE:.spec.containers[*].image \\
  --field-selector=status.phase=Succeeded"
end_step

section "Inside the frontend container (nginx)" \
        "Runs as non-root user 101"
run "kubectl -n $NS exec deploy/frontend -- id"
end_step

section "Inside the API container (Node 24)" \
        "The API answers its health check from inside its own container"
run "kubectl -n $NS exec deploy/api -c api -- node -e \"fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)\""
end_step

section "Migrations (init container in every API pod)" \
        "Database migrations ran before the API started"
run "kubectl -n $NS logs deploy/api -c migrate | tail -3"
end_step

section "Inside the PostgreSQL 18 container" \
        "A live query: PostgreSQL version and the number of products"
run "kubectl -n $NS exec postgres-0 -- psql -U stocksync -d stocksync -tAc \"select version(), (select count(*) from products)\""
end_step

section "Backup job" \
        "Last lines of the most recent nightly backup (uploaded to DigitalOcean Spaces)"
run "kubectl -n $NS logs \$(kubectl -n $NS get jobs -o name | grep db-backup | tail -1) | tail -3"
end_step

section "Persistent storage for PostgreSQL" \
        "StatefulSet + PVC bound to a DigitalOcean Volume, mounted at /var/lib/postgresql"
run "kubectl -n $NS get statefulset,pvc"
run "kubectl -n $NS exec postgres-0 -- df -h /var/lib/postgresql"
end_step

# --------------------------------------------------------------------------- #
# Part 2 – zero-downtime rolling update
#   Default: show the recorded run from rolling-update-recorded.txt (fast).
#   LIVE=1 ./terminal-demo.sh   runs the rolling update for real instead.
# --------------------------------------------------------------------------- #
RECORDED="$(dirname "$0")/rolling-update-recorded.txt"

show_recorded() {   # show_recorded 10  – prints that part of the recorded file
  awk -v part="### STEP $1" '
    $0 ~ /^### STEP / { show = ($0 == part); next }
    show' "$RECORDED" |
  Y="$YELLOW" G="$GREEN" R="$RED" B="$BOLD" N="$RESET" perl -pe '
    if (/^\$ /)        { $_ = "$ENV{Y}$_"; s/\n$/$ENV{N}\n/; next }
    if (/^20 \/ 20 /)   { $_ = "$ENV{G}$ENV{B}$_"; s/\n$/$ENV{N}\n/; next }
    if (/^ADDED/)       { $_ = "$ENV{G}$_"; s/\n$/$ENV{N}\n/; next }
    if (/^DELETED/)     { $_ = "$ENV{R}$_"; s/\n$/$ENV{N}\n/; next }
    s/(?<![.\d])200(?![.\d])/$ENV{G}200$ENV{N}/g;'
  echo
}

if [ -z "${LIVE:-}" ] && [ -f "$RECORDED" ]; then
  section "Zero-downtime rolling update of the API (recorded run)" \
          "API pods were replaced one by one while the live site was checked every second"
  show_recorded 10; end_step
  section "What Kubernetes did during the update (recorded run)" \
          "New pods ADDED and started before the old pods were DELETED"
  show_recorded 11; end_step
  section "API pods after the update (recorded run)" \
          "Brand-new API pods, still one per node, same image"
  show_recorded 12
  printf '%s\n\n' "${GREEN}${BOLD}Demo finished.${RESET}"
  exit 0
fi

section "Zero-downtime rolling update of the API" \
        "Replace the API pods one by one while checking the live site every second"
printf '%s\n' "${YELLOW}\$ kubectl -n $NS get pods -l app.kubernetes.io/name=api -w   (recording in the background)${RESET}"
kubectl -n "$NS" get pods -l app.kubernetes.io/name=api -w --output-watch-events \
  > /tmp/stocksync-api-watch.log 2>&1 &
WATCH_PID=$!
sleep 1
run "kubectl -n $NS rollout restart deployment/api"

kubectl -n "$NS" rollout status deployment/api --timeout=180s > /tmp/stocksync-rollout.log 2>&1 &
ROLLOUT_PID=$!

printf '%s\n' "${YELLOW}\$ curl $SITE/api/health   (every second until the rollout is finished)${RESET}"
ok=0; total=0
while kill -0 "$ROLLOUT_PID" 2>/dev/null || [ "$total" -lt 20 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$SITE/api/health")
  total=$((total + 1))
  if [ "$code" = "200" ]; then ok=$((ok + 1)); printf '%s ' "${GREEN}${code}${RESET}"
  else printf '%s ' "${RED}${code}${RESET}"; fi
  sleep 1
done
echo; echo
wait "$ROLLOUT_PID" 2>/dev/null
cat /tmp/stocksync-rollout.log
echo
if [ "$ok" -eq "$total" ]; then
  printf '%s\n' "${GREEN}${BOLD}${ok} / ${total} requests returned 200 during the update: zero downtime${RESET}"
else
  printf '%s\n' "${RED}${BOLD}${ok} / ${total} requests returned 200${RESET}"
fi
sleep 2
kill "$WATCH_PID" 2>/dev/null
end_step

section "What Kubernetes did during the update" \
        "Pod events recorded while the site was being checked: new pods ADDED, old pods DELETED"
cat /tmp/stocksync-api-watch.log
echo
end_step

section "API pods after the update" \
        "Brand-new API pods (AGE: seconds), still one per node, same image tag"
run "kubectl -n $NS get pods -l app.kubernetes.io/name=api -o wide"
printf '%s\n\n' "${GREEN}${BOLD}Demo finished.${RESET}"

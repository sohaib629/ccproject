# Kubernetes deployment

StockSync runs on Kubernetes with the same three tiers as Docker Compose. The
manifests are in `k8s/`, organised with Kustomize (built into `kubectl -k`):

```
k8s/
  base/                 shared by every environment
    namespace.yaml      namespace "stocksync"
    configmap.yaml      api-config: non-secret API settings
    postgres.yaml       headless Service + StatefulSet + volumeClaimTemplate (PVC)
    api.yaml            Service + Deployment (2 replicas) + PodDisruptionBudget
    frontend.yaml       Service + Deployment (2 replicas)
    kustomization.yaml
  overlays/
    minikube/           local images (:dev, never pulled), DEPLOY_ENV=minikube
  bootstrap.sh          creates the Secret and the init-SQL ConfigMap (not stored in git)
```

## From Docker Compose to Kubernetes

| Docker Compose | Kubernetes | Notes |
|---|---|---|
| `db` service + `db-data` volume | `StatefulSet postgres` + PVC `data-postgres-0` | stable pod name; the PVC is re-attached to every replacement pod |
| `api` service | `Deployment api` (2 replicas) + `Service api` | stateless; the Service load-balances across replicas |
| `frontend` service | `Deployment frontend` (2 replicas) + `Service frontend` | nginx forwards `/api/` to `Service api` |
| `app-network` + service-name DNS | cluster DNS: `postgres`, `api`, `frontend` | the app config is unchanged (`DB_HOST=postgres`, `API_UPSTREAM=http://api:3000`) |
| `secrets:` from `secrets/*.txt` | `Secret stocksync-secrets` mounted at `/run/secrets` | same file paths as Compose; created by `bootstrap.sh` |
| `database/init` bind mount | `ConfigMap db-init-sql` mounted at `/docker-entrypoint-initdb.d` | generated from the same SQL files |
| `healthcheck:` | `readinessProbe` / `livenessProbe` | readiness `/ready` (DB reachable), liveness `/health` (process alive) |
| `restart: unless-stopped` | controllers (ReplicaSet, StatefulSet) | deleted or crashed pods are recreated automatically |
| published ports | `kubectl port-forward` locally; Gateway + Load Balancer on DOKS | all Services are `ClusterIP`/headless: internal only |

## Design decisions

- **StatefulSet for PostgreSQL.** A stable identity (`postgres-0`) and a
  `volumeClaimTemplate`, so the data disk follows the pod. The storage class is left
  unset so each cluster uses its default: `standard` on minikube, `do-block-storage`
  (a DigitalOcean Volume) on DOKS. The volume is mounted at `/var/lib/postgresql`
  because PostgreSQL 18 stores data in `/var/lib/postgresql/18/docker`.
- **Headless Service for PostgreSQL.** DNS `postgres` resolves directly to
  `postgres-0`; there is only one database pod, so no load balancing is needed.
- **Two replicas of the API and frontend.** Rolling updates use `maxSurge: 1,
  maxUnavailable: 0`, so capacity never drops during a deploy. A `preStop` sleep
  gives the Service time to stop routing to a pod before it receives SIGTERM.
  `topologySpreadConstraints` spread replicas across nodes when there are several (DOKS).
- **Probes split by purpose.** If PostgreSQL goes down, API pods become *not ready*
  (the Service stops routing to them) but are *not restarted*, because liveness
  does not depend on the database.
- **Resource requests.** The API requests `100m` CPU; the Horizontal Pod Autoscaler
  (Day 6) scales on a percentage of this request.
- **Pod security.** API and frontend run as non-root with all Linux capabilities
  dropped, no privilege escalation and the default seccomp profile; the API also has
  a read-only root filesystem. Secret files are mode `0440`, readable only by the
  pod's group (`fsGroup`). The database pod mounts only `db_password`, not the JWT key.
- **No service-account token.** No pod calls the Kubernetes API, so
  `automountServiceAccountToken: false` removes an unneeded credential. It is also
  required for our `/run/secrets` mount: in Debian-based images `/var/run` is a
  symlink to `/run`, so the automatic token mount (`/var/run/secrets/kubernetes.io/...`)
  collided with the read-only Secret volume and the containers failed with
  `RunContainerError` on the first deploy.
- **Downward API.** Each API pod receives its pod name, namespace, node and IP as
  environment variables, shown on the admin System page.
- **Known limitations.** One PostgreSQL replica is a single point of failure. A
  Kubernetes Secret is base64-encoded, not encrypted: access is limited by RBAC, and
  managed clusters (DOKS) encrypt etcd at rest.

## Verification on minikube

Run these with the stack deployed (see the Kubernetes section of the README).

| Test | Command | Expected |
|---|---|---|
| All pods ready | `kubectl -n stocksync get pods` | `postgres-0`, 2× `api-…`, 2× `frontend-…`, all `1/1 Running` |
| Load balancing | `API_URL=http://localhost:7080 node tests/concurrency-test.mjs` | requests answered by **both** API pods |
| Correctness across replicas | same command | exactly 1 sale of the last unit, quantity 0, 1 audit row |
| Persistence | `kubectl -n stocksync delete pod postgres-0`, wait, check data | the same PVC is re-attached; sales and history are still there |
| Self-healing | `kubectl -n stocksync delete pod -l app.kubernetes.io/name=api --wait=false` | replacements are created; the Deployment returns to 2/2 |
| Rolling update + rollback | `kubectl -n stocksync rollout restart deploy/api`, then `rollout undo` | new pods replace old ones one at a time, with no downtime |
| Readiness during DB outage | `kubectl -n stocksync scale sts/postgres --replicas=0` | API pods become `0/1` (not ready) but are **not restarted**; scale back to 1 and they recover |

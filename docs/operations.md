# Operations: auto-scaling, continuous deployment, backup and recovery

These are three of the four advanced features in the proposal (the fourth,
security, is described in the README). All three run on the DOKS deployment
described in [deployment.md](deployment.md).

---

## 1. Auto-scaling: Horizontal Pod Autoscaler

| | |
|---|---|
| Manifest | `k8s/base/hpa.yaml` (both minikube and DOKS) |
| Target | `Deployment/api` |
| Range | **2 → 5 replicas** |
| Metric | average CPU **70% of the request** (request = 100m, so ~70m per pod) |
| Scale up | immediately, at most +2 pods every 30 s |
| Scale down | after 2 min of low load, −1 pod per minute |

**Why it is safe to scale the API:** the API is stateless (login state is in the
JWT, data is in PostgreSQL) and stock consistency is enforced by PostgreSQL
transactions, so 5 replicas sell the last unit exactly once, just like 2.
`DB_POOL_MAX=10` × 5 replicas = 50 connections, below PostgreSQL's default 100.

**The Deployment has no `replicas:` field.** The HPA owns the count. With a fixed
value, every `kubectl apply` would reset the count to 2 in the middle of a load
spike. (The first deploy after removing the field briefly sets 1 replica, and
the HPA restores 2 within seconds; one pod keeps serving, so there is no outage.)

**Metrics pipeline.** The HPA needs metrics-server. On minikube:
`minikube -p stocksync addons enable metrics-server`. On DOKS check with
`kubectl top nodes`; if it reports "Metrics API not available", install it once:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system rollout status deploy/metrics-server
kubectl top nodes
```

### Load test (k6)

`tests/load/hpa-load.js`: about 8 minutes of sustained load. Many small reads
(products, stock, low stock, history) plus a steady stream of logins. bcrypt
hashing is deliberately CPU-heavy, which is what pushes the API above its target.
The test never sells or restocks, so data is unchanged.

```bash
# terminal 1: watch the autoscaler and the pods
kubectl -n stocksync get hpa api -w
kubectl -n stocksync get pods -l app.kubernetes.io/name=api -o wide -w
kubectl -n stocksync top pods

# terminal 2: run the load (brew install k6)
BASE_URL=https://stocksync.online DEMO_PASSWORD='<demo password>' k6 run tests/load/hpa-load.js
```

Tunables: `VUS` (default 40), `LOGIN_RATE` (logins/second, default 4), `HOLD`
(default `5m`).

**Expected:** CPU in `kubectl get hpa` climbs above 70%, REPLICAS goes from 2 to
3–5, new pods spread over both nodes, k6 reports < 1% failed requests. After the
test, replicas return to 2 over a few minutes.

**What the first run taught us.** The HPA scaled 2 → 4 → 5 within a minute,
but 3.5% of requests failed (57% of logins). Two causes, both fixed:

1. *Probe timeouts.* Probes used the default 1 s timeout. A pod busy with bcrypt
   logins (CPU-throttled at its 500m limit) answered `/ready` too slowly, so it
   flapped out of the Service, pushing more load onto the others, and one pod was
   restarted by its liveness probe. Probes now allow 3 s (readiness) and 5 s ×
   6 failures (liveness).
2. *Rate limiter counted the wrong things.* Every non-2xx login answer counted
   towards the 10-attempt limit, including 5xx from overloaded pods and the 429s
   themselves, and all traffic arrives from the load balancer's address. A few
   errors therefore locked *everyone* out for 15 minutes. Now only wrong
   credentials (401) count (`backend/test/auth.test.js`).

Correctness and scaling are tested separately: `tests/concurrency-test.mjs`
(a short burst) proves transactions, but only *sustained* load moves the HPA,
which averages CPU over time.

---

## 2. Continuous deployment: GitHub Actions → DOCR → DOKS

```
PR opened ──► CI (4 required checks) ──► merge to main
                                              │
                              CI runs again on main ── green ──► CD (.github/workflows/cd.yml)
                                                                   1. build api, frontend, backup (linux/amd64)
                                                                   2. push to DOCR as :<commit>
                                                                   3. backup the database (restore point)
                                                                   4. k8s/deploy.sh doks <commit>   (rolling update;
                                                                      new pods run migrations first)
                                                                   5. verify: live commit = <commit> + smoke test
```

* **Only tested code is deployed.** CD starts only when CI succeeds for a *push* to
  `main`, and it checks out exactly the commit CI tested.
* **Same path as a manual deploy.** CD runs `k8s/deploy.sh`, so a deploy by hand
  and a deploy by CD are identical.
* **Zero downtime.** `deploy.sh` applies a rolling update (`maxSurge 1`,
  `maxUnavailable 0`, readiness probes, `preStop` delay).
* **One at a time.** A `concurrency` group queues a second deployment instead of
  running two at once.
* **Rollback.** Actions → CD → *Run workflow* with an earlier tag deploys that
  version without rebuilding. The job summary of every run shows the previous tag.
* **Proof the new version is live.** `deploy.sh` stamps `GIT_SHA` (the tag) and
  `DEPLOYED_AT` into the API pods; `/api/health` reports them, and CD asks
  several times until every answer reports the new commit. The same build is
  shown on the System page (linked to the GitHub commit) and in the page footer.
* **Credentials.** A DigitalOcean API token in the GitHub environment
  `production` (encrypted secret). The registry login and kubeconfig it creates
  expire after 30 minutes. Nothing is stored in git.

### One-time setup

1. DigitalOcean → API → *Generate New Token*: name `github-cd`, expiry 90 days,
   **custom scopes** for the container registry (read + push) and Kubernetes
   (read + access cluster). If a step later fails with 403, regenerate it with
   the missing scope.
2. GitHub environment and settings:
   ```bash
   gh api -X PUT repos/sohaib629/ccproject/environments/production
   gh secret   set DIGITALOCEAN_ACCESS_TOKEN --env production    # paste the token
   gh variable set DOCR_REGISTRY --env production --body stocksync-sohaib
   gh variable set CLUSTER_NAME  --env production --body stocksync
   ```

### Rollback by hand (if GitHub is unavailable)

```bash
DOCR_REGISTRY=stocksync-sohaib ./k8s/deploy.sh doks <earlier-commit>
# or, for the API only:  kubectl -n stocksync rollout undo deploy/api
```

---

## 3. Backup and recovery

| | |
|---|---|
| What | `pg_dump` custom format (compressed) of the `stocksync` database |
| When | CronJob `db-backup`, nightly at 03:00 Toronto time |
| Where | DigitalOcean Spaces bucket `stocksync-backups`, folder `postgres/` (outside the cluster) |
| Kept | newest **7** (older ones are deleted by the job) |
| Credentials | a Spaces key **limited to that one bucket**, mounted from the Secret `spaces-credentials`; the job gets only the DB password, not the JWT key |
| Code | `backup/` (image `stocksync-backup`), `k8s/overlays/doks/backup.yaml` |

Each backup writes two objects: `stocksync-<UTC time>.dump` and a manifest
`stocksync-<UTC time>.json` with row counts, total units in stock and checksums
of the product catalogue and the full audit history. Before uploading, the job
checks that the archive is readable (`pg_restore --list`).

**The PVC is not a backup.** It survives pod restarts and rescheduling, but not
deleting the volume, the namespace or the cluster, and it faithfully keeps any
bad change. The backups live outside the cluster.

### Restore test

The suspended CronJob `db-restore-test` never runs on a schedule; it is started
on demand. It downloads the newest backup, restores it into a **separate
database `stocksync_restore`** on the same server (the live database is only
read), then checks:

* every count and checksum equals the manifest recorded at backup time;
* the integrity rules of `database/checks.sql`: stock equals the audit history,
  no negative stock, every received transfer has exactly one `transfer_in`;
* the append-only audit trigger was restored.

It then drops `stocksync_restore` and exits non-zero if anything failed.

```bash
# take a backup now (instead of waiting for 03:00)
kubectl -n stocksync create job backup-now-$(date +%s) --from=cronjob/db-backup
kubectl -n stocksync logs -f job/<name>

# prove it restores
kubectl -n stocksync create job restore-test-$(date +%s) --from=cronjob/db-restore-test
kubectl -n stocksync logs -f job/<name>          # "Result: 14 passed, 0 failed"
```

### Recovering the live database from a backup (real incident)

Only if the live data is lost or corrupted. This replaces it.

```bash
kubectl -n stocksync scale deploy/api --replicas=0         # stop writes (an HPA leaves a target at 0 alone)
# copy the chosen dump into the database pod and restore over the live database
kubectl -n stocksync cp stocksync-<time>.dump postgres-0:/tmp/restore.dump
kubectl -n stocksync exec postgres-0 -- pg_restore -U stocksync -d stocksync --clean --if-exists --no-owner /tmp/restore.dump
kubectl -n stocksync scale deploy/api --replicas=2         # the HPA takes over again
```

(Download the dump from the Spaces control panel, or with any S3 client using
the bucket key.)

### One-time setup

1. Control panel → **Spaces Object Storage** → *Create bucket*: region **NYC3**,
   name `stocksync-backups`, file listing **restricted**. (If the name is
   taken, pick another and change `S3_BUCKET` in `backup.yaml`.)
2. **Spaces Object Storage → Access Keys** → *Create access key* → **Limited
   access** → bucket `stocksync-backups`, permission **Read/Write/Delete**
   (delete is needed for the 7-backup retention).
3. Save both halves in git-ignored files and create the Secret:
   ```bash
   printf '%s' '<access key>' > secrets/spaces_access_key.txt
   printf '%s' '<secret key>' > secrets/spaces_secret_key.txt
   DOCR_REGISTRY=stocksync-sohaib ./k8s/bootstrap.sh doks
   ```

**Limitation:** with nightly backups, up to about a day of changes could be lost.
Continuous WAL archiving (point-in-time recovery) would reduce that; it is out
of scope.

---

## 4. Database migrations

`database/init/*.sql` is the **baseline**: PostgreSQL runs it once, on an empty
volume. Every later schema or data change is a numbered file in
`backend/migrations/`:

| File | Change |
|---|---|
| `001_distribution_centre.sql` | location `kind` (`store`/`warehouse`), the distribution centre WH and its two users, opening stock, and a trigger: sales only at stores, supplier deliveries only at the DC |
| `002_catalogue_100_products.sql` | 88 more products (100 in total) with opening stock at all three locations |

**Runner:** `backend/src/migrate.js` (`node src/migrate.js`).

* Records each applied file and its SHA-256 in `schema_migrations`; a file runs
  **at most once**. Changing an applied file is refused: add a new file instead.
* Each file runs in **one transaction**: all of it or nothing.
* A PostgreSQL **advisory lock** serialises runners, so several pods starting
  together cannot apply the same file twice.

**Where it runs:**

| Environment | How |
|---|---|
| Kubernetes (minikube, DOKS) | **init container** `migrate` in every API pod, same image as the app. A failed migration keeps the new pod from starting; with `maxUnavailable: 0` the old pods keep serving and the deploy fails visibly (`deploy.sh` prints the migration log) |
| Docker Compose | one-off `migrate` service; the API starts only after it exits successfully |
| Tests | the harness applies every migration after loading the baseline |

**Safety net.** CD takes a backup *before* each deploy, so a release with a bad
migration can be undone: restore that backup (section 3) and redeploy the
previous tag. New migrations should be **backward compatible** for the few
seconds of a rolling update (old pods still running against the new schema):
add columns and rows, do not rename or drop in the same release.

```bash
kubectl -n stocksync logs deploy/api -c migrate        # what the latest pod's init container did
kubectl -n stocksync exec postgres-0 -- psql -U stocksync -d stocksync \
  -c "SELECT version, applied_at FROM schema_migrations ORDER BY version"
```

# Local secrets (not committed)

Docker Compose reads these files and mounts them into containers under
`/run/secrets/`. They are git-ignored. Create them once:

```bash
openssl rand -hex 24 > secrets/db_password.txt
openssl rand -hex 32 > secrets/jwt_secret.txt
```

In Kubernetes the same values become a `Secret` (created by `k8s/bootstrap.sh`).

For backups on DigitalOcean, also save a Spaces access key that is limited to
the backup bucket (see docs/operations.md):

```bash
printf '%s' '<access key>' > secrets/spaces_access_key.txt
printf '%s' '<secret key>' > secrets/spaces_secret_key.txt
```

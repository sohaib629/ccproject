# Local secrets (not committed)

Docker Compose reads these files and mounts them into containers under
`/run/secrets/`. They are git-ignored. Create them once:

```bash
openssl rand -hex 24 > secrets/db_password.txt
openssl rand -hex 32 > secrets/jwt_secret.txt
```

In Kubernetes the same values become a `Secret` (Day 4).

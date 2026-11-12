# =============================================================================
# StockSync backup image: PostgreSQL 18 client tools + AWS CLI (for Spaces).
# Runs as the Kubernetes CronJob "db-backup" (nightly pg_dump to Spaces) and the
# on-demand Job "db-restore-test" (restore the latest backup into a separate
# database and verify it). The client major version (18) matches the server.
# =============================================================================
FROM postgres:18-alpine

# aws-cli talks to DigitalOcean Spaces through its S3-compatible API.
# `apk upgrade` pulls in security fixes published since the base image was built.
RUN apk upgrade --no-cache && apk add --no-cache bash aws-cli coreutils
# gosu is only used by the PostgreSQL server entrypoint to drop root privileges.
# This image never runs that entrypoint (it starts as uid 70), so remove the
# binary: it was built with an old Go version (CVE-2025-68121, found by the CI
# image scan), and unused binaries are attack surface.
RUN rm -f /usr/local/bin/gosu

COPY --chmod=0755 backup-common.sh backup.sh restore-test.sh /usr/local/bin/

# The "postgres" user (uid 70) from the base image; never root.
USER 70:70
ENV HOME=/tmp
ENTRYPOINT ["/bin/bash"]
CMD ["/usr/local/bin/backup.sh"]

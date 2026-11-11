# =============================================================================
# StockSync backup image: PostgreSQL 18 client tools + AWS CLI (for Spaces).
# Runs as the Kubernetes CronJob "db-backup" (nightly pg_dump to Spaces) and the
# on-demand Job "db-restore-test" (restore the latest backup into a separate
# database and verify it). The client major version (18) matches the server.
# =============================================================================
FROM postgres:18-alpine

# aws-cli talks to DigitalOcean Spaces through its S3-compatible API.
RUN apk add --no-cache bash aws-cli coreutils

COPY --chmod=0755 backup-common.sh backup.sh restore-test.sh /usr/local/bin/

# The "postgres" user (uid 70) from the base image; never root.
USER 70:70
ENV HOME=/tmp
ENTRYPOINT ["/bin/bash"]
CMD ["/usr/local/bin/backup.sh"]

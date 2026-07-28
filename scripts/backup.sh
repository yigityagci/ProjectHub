#!/usr/bin/env bash
#
# ProjectHub backup script.
#
# Backs up the two pieces of state a self-hosted ProjectHub instance
# actually needs to survive a disaster or a migration to new hardware:
#
#   1. The PostgreSQL database (via `pg_dump` inside the running `db`
#      service), gzipped.
#   2. The `uploads` volume (Phase 4 attachments), copied out of the
#      running `api` container with `docker cp` (which streams files
#      straight from the daemon - it does not require `tar`/any other
#      tool to be installed inside the container image) and then tarred
#      up locally.
#
# This is a functional, straightforward backup script for a single-node
# self-hosted deployment - it is not a full disaster-recovery solution
# (no offsite replication, no point-in-time recovery, no encryption at
# rest for the backup files themselves). Store the output directory
# somewhere durable (a separate disk, offsite storage, etc.) yourself.
#
# Usage (run from the repository root, where docker-compose.yml lives):
#   ./scripts/backup.sh [output-directory]
#
# Requires: a running stack (`docker-compose up -d`) and Docker CLI
# access from wherever this script runs.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE_CMD="docker-compose"
if ! command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
fi

OUT_DIR="${1:-./backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"

# Pick up POSTGRES_USER/POSTGRES_DB from .env if present, so this always
# matches whatever the stack was actually configured with (falls back to
# the same defaults as docker-compose.yml/.env.example).
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
POSTGRES_USER="${POSTGRES_USER:-projecthub}"
POSTGRES_DB="${POSTGRES_DB:-projecthub}"

echo "==> Backing up database '$POSTGRES_DB' ..."
DB_DUMP_FILE="$OUT_DIR/projecthub-db-$TIMESTAMP.sql.gz"
$COMPOSE_CMD exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges \
  | gzip > "$DB_DUMP_FILE"
echo "    -> $DB_DUMP_FILE"

echo "==> Backing up uploads (attachments) ..."
API_CONTAINER="$($COMPOSE_CMD ps -q api)"
UPLOADS_TAR="$OUT_DIR/projecthub-uploads-$TIMESTAMP.tar.gz"
if [ -z "$API_CONTAINER" ]; then
  echo "    ! Could not find a running 'api' container - is the stack up? Skipping uploads backup." >&2
else
  STAGE_DIR="$(mktemp -d)"
  # UPLOAD_DIR defaults to "uploads", resolved relative to the api
  # process's working directory (/workspace/apps/api in the container
  # image - see apps/api/Dockerfile) - matches the `uploads` named volume
  # declared in docker-compose.yml.
  docker cp "$API_CONTAINER:/workspace/apps/api/uploads" "$STAGE_DIR/uploads"
  tar -czf "$UPLOADS_TAR" -C "$STAGE_DIR" uploads
  rm -rf "$STAGE_DIR"
  echo "    -> $UPLOADS_TAR"
fi

echo
echo "==> Backup complete. Verify both files before relying on them:"
echo "    gzip -t \"$DB_DUMP_FILE\" && echo 'db dump OK'"
if [ -n "$API_CONTAINER" ]; then
  echo "    tar -tzf \"$UPLOADS_TAR\" > /dev/null && echo 'uploads archive OK'"
fi
echo
echo "See docs/BACKUP_AND_RESTORE.md for the full restore procedure and"
echo "how to verify a restore succeeded."

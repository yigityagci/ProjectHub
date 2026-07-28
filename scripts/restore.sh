#!/usr/bin/env bash
#
# ProjectHub restore script. Restores a database dump (and, optionally, an
# uploads archive) produced by scripts/backup.sh into a running
# docker-compose stack.
#
# WARNING: this OVERWRITES the current database contents and uploads
# directory of the running stack. Take a fresh backup first
# (`./scripts/backup.sh`) if you need to preserve the current state before
# restoring an older one.
#
# Usage (run from the repository root, where docker-compose.yml lives):
#   ./scripts/restore.sh <db-dump.sql.gz> [uploads-archive.tar.gz]
#
# Requires: a running stack's `db` (and, if restoring uploads, `api`)
# service reachable via `docker-compose`/`docker compose`, and Docker CLI
# access from wherever this script runs.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <db-dump.sql.gz> [uploads-archive.tar.gz]" >&2
  exit 1
fi

DB_DUMP="$1"
UPLOADS_ARCHIVE="${2:-}"

if [ ! -f "$DB_DUMP" ]; then
  echo "Database dump not found: $DB_DUMP" >&2
  exit 1
fi
if [ -n "$UPLOADS_ARCHIVE" ] && [ ! -f "$UPLOADS_ARCHIVE" ]; then
  echo "Uploads archive not found: $UPLOADS_ARCHIVE" >&2
  exit 1
fi

COMPOSE_CMD="docker-compose"
if ! command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
fi

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
POSTGRES_USER="${POSTGRES_USER:-projecthub}"
POSTGRES_DB="${POSTGRES_DB:-projecthub}"

echo "This will REPLACE all data in database '$POSTGRES_DB'"
if [ -n "$UPLOADS_ARCHIVE" ]; then
  echo "and REPLACE the entire uploads directory"
fi
read -r -p "of the running stack. Are you sure? Type 'yes' to continue: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

echo "==> Stopping the API so it can't write during the restore ..."
$COMPOSE_CMD stop api

echo "==> Dropping and recreating database '$POSTGRES_DB' ..."
$COMPOSE_CMD exec -T db psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\";"
$COMPOSE_CMD exec -T db psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"

echo "==> Restoring database from $DB_DUMP ..."
gunzip -c "$DB_DUMP" | $COMPOSE_CMD exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1

if [ -n "$UPLOADS_ARCHIVE" ]; then
  echo "==> Restoring uploads from $UPLOADS_ARCHIVE ..."
  echo "    (starting the api container so its uploads volume is mounted and writable)"
  $COMPOSE_CMD up -d api
  # Give the container a moment to actually be up (its own healthcheck may
  # still be failing at this point because migrations haven't finished
  # applying against the freshly-restored schema yet - `docker exec`/
  # `docker cp` only need the container process to be running, not healthy).
  for _ in $(seq 1 15); do
    API_CONTAINER="$($COMPOSE_CMD ps -q api)"
    [ -n "$API_CONTAINER" ] && break
    sleep 1
  done
  if [ -z "${API_CONTAINER:-}" ]; then
    echo "    ! Could not find the 'api' container - restore the uploads archive manually with 'docker cp'." >&2
  else
    STAGE_DIR="$(mktemp -d)"
    tar -xzf "$UPLOADS_ARCHIVE" -C "$STAGE_DIR"
    # Clear the destination first so this is a true replace, not an
    # additive merge with whatever is currently in the volume.
    docker exec "$API_CONTAINER" sh -c 'rm -rf /workspace/apps/api/uploads/* /workspace/apps/api/uploads/.[!.]* 2>/dev/null || true'
    docker cp "$STAGE_DIR/uploads/." "$API_CONTAINER:/workspace/apps/api/uploads"
    rm -rf "$STAGE_DIR"
  fi
fi

echo "==> Starting (or restarting) the API - this applies any pending migrations first ..."
$COMPOSE_CMD up -d api

echo
echo "==> Restore complete. Verify it succeeded:"
echo "    $COMPOSE_CMD exec db psql -U $POSTGRES_USER -d $POSTGRES_DB -c '\\dt'   # tables exist"
echo "    curl -f http://localhost:\${PORT:-4000}/health/ready                    # API is healthy"
echo "    Then log in through the web UI and confirm workspaces/projects/tasks"
echo "    (and, if restored, attachments) are present and downloadable."

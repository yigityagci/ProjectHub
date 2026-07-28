# Backup and restore

ProjectHub's persistent state lives in exactly two places, both already
declared as named Docker volumes in `docker-compose.yml`:

| What | Where | Volume |
|---|---|---|
| Everything except file attachments (users, workspaces, projects, tasks, comments, notifications, activity, audit log, sessions, ...) | PostgreSQL | `pgdata` |
| File attachments (Phase 4) | Local-disk `StorageProvider` | `uploads` |

Redis (`redisdata`) is **not** backed up: it only holds sessions,
rate-limit counters, and Socket.IO pub/sub state, all of which are safe to
lose (users simply have to log in again after a restore).

This page documents the exact commands. The scripts referenced below
(`scripts/backup.sh`, `scripts/restore.sh`) are functional, straightforward
tools for a single-node self-hosted deployment - they are **not** a full
disaster-recovery solution (no offsite replication, no point-in-time
recovery, no encryption of the backup files themselves, not exhaustively
tested against every failure mode). Treat them as a solid starting point,
and store the output directory somewhere durable (a separate disk, offsite
object storage, etc.) yourself.

## Backing up

From the repository root, with the stack running (`docker-compose up -d`):

```bash
./scripts/backup.sh
# or, to choose a different output directory:
./scripts/backup.sh /path/to/backup-storage
```

This produces two timestamped files in `./backups/` (or the directory you
passed):

- `projecthub-db-<timestamp>.sql.gz` - a gzipped `pg_dump` of the whole
  database (schema + data), taken with `--no-owner --no-privileges` so it
  restores cleanly regardless of which Postgres role name is used.
- `projecthub-uploads-<timestamp>.tar.gz` - a tarball of the entire
  `uploads` volume, copied out of the running `api` container with
  `docker cp` (which streams files directly from the Docker daemon - it
  does not require `tar` to be installed inside the container image
  itself) and then compressed locally.

If you'd rather run the equivalent commands by hand instead of the script
(e.g. to fold into your own backup tooling):

```bash
# Database:
docker-compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --no-owner --no-privileges | gzip > projecthub-db.sql.gz

# Uploads:
docker cp "$(docker-compose ps -q api):/workspace/apps/api/uploads" ./uploads-copy
tar -czf projecthub-uploads.tar.gz -C ./uploads-copy .
rm -rf ./uploads-copy
```

**Schedule this.** A single manual backup before a risky change is useful,
but for real production use, run `scripts/backup.sh` on a cron job (or
your platform's scheduler) and copy the output off the host regularly.

### Verifying a backup is usable

Immediately after taking a backup, confirm both archives are actually
readable (a truncated/corrupt backup is worse than no backup, because it
creates false confidence):

```bash
gzip -t projecthub-db-<timestamp>.sql.gz && echo "db dump OK"
tar -tzf projecthub-uploads-<timestamp>.tar.gz > /dev/null && echo "uploads archive OK"
```

For a stronger guarantee, periodically do a full restore rehearsal (see
below) into a throwaway/staging stack, not just a file integrity check.

## Restoring

**This overwrites the current database and uploads directory of the
running stack.** If the current state matters, back it up first
(`./scripts/backup.sh`) before restoring an older backup over it.

```bash
./scripts/restore.sh projecthub-db-<timestamp>.sql.gz projecthub-uploads-<timestamp>.tar.gz
# Uploads archive is optional - to restore only the database:
./scripts/restore.sh projecthub-db-<timestamp>.sql.gz
```

The script will:

1. Ask for explicit confirmation (`yes`) before doing anything destructive.
2. Stop the `api` service so nothing writes to the database mid-restore.
3. `DROP` and recreate the target database, then pipe the gzipped dump
   into `psql` to restore it.
4. If an uploads archive was given: start the `api` container back up
   (needed so its volume mount is writable), clear the current contents of
   the `uploads` volume, and `docker cp` the archive's contents back in.
5. Start (or restart) the `api` service - its container entrypoint runs
   `prisma migrate deploy` on boot, so any migrations newer than the
   restored dump are applied automatically.

If you'd rather run the underlying commands by hand:

```bash
docker-compose stop api

docker-compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
  -c 'DROP DATABASE IF EXISTS "'"$POSTGRES_DB"'";'
docker-compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
  -c 'CREATE DATABASE "'"$POSTGRES_DB"'" OWNER "'"$POSTGRES_USER"'";'
gunzip -c projecthub-db.sql.gz | docker-compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# Uploads (optional):
docker-compose up -d api
tar -xzf projecthub-uploads.tar.gz -C /tmp/uploads-restore
docker exec "$(docker-compose ps -q api)" sh -c 'rm -rf /workspace/apps/api/uploads/*'
docker cp /tmp/uploads-restore/uploads/. "$(docker-compose ps -q api):/workspace/apps/api/uploads"

docker-compose up -d api
```

### Verifying a restore succeeded

After running `scripts/restore.sh` (or the manual steps above):

1. **API health:** `curl -f http://localhost:4000/health/ready` should
   return `200`. If it doesn't, check `docker-compose logs api` - the most
   common cause is a migration failure (see the troubleshooting section in
   [`docs/PRODUCTION.md`](PRODUCTION.md)).
2. **Data present:** log into the web UI and confirm your workspaces,
   projects, and tasks are there and match what you expect from the backup
   point in time.
3. **Table sanity check:**
   `docker-compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c '\dt'`
   should list all of ProjectHub's tables (`users`, `workspaces`, `tasks`,
   `attachments`, ... - see `apps/api/prisma/schema.prisma` for the full
   list).
4. **Attachments present (if restored):** open a task that had an
   attachment before the backup was taken and confirm it downloads
   successfully - this exercises the full authorized-download path
   (`requireAuth` + `requireMembership` + `requireProjectAccess`), not just
   "the file exists on disk."

## What is intentionally out of scope here

- **Point-in-time recovery** (continuous WAL archiving) - this is a
  periodic full-dump strategy, so you can only restore to the moment the
  last backup was taken, not to an arbitrary point in between. If your
  deployment needs tighter RPO guarantees, consider Postgres
  streaming/WAL-based replication in addition to this.
- **Encryption of backup files at rest** - the `.sql.gz`/`.tar.gz` files
  contain the same sensitive data as the live database (password hashes,
  task/comment content, uploaded files). Encrypt or restrict access to
  wherever you store them.
- **Automatic offsite upload** - `scripts/backup.sh` only writes to a local
  directory; copying that directory offsite (S3, another host, etc.) is
  left to the self-hoster's own tooling/cron setup.
- **Cross-version schema migration testing** - restoring a very old dump
  into a much newer ProjectHub version should work (Prisma migrations are
  additive and run automatically), but this has not been exhaustively
  tested across every possible version gap.

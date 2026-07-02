#!/bin/sh
# Restore a backup tar produced by scripts/backup.sh into the compose data
# volume. DESTRUCTIVE: replaces the current database and all images.
#
# Usage: scripts/restore.sh backups/coop-YYYYMMDD-HHMMSS.tar
set -eu

tarfile=${1:?usage: scripts/restore.sh <backup.tar>}
[ -f "$tarfile" ] || { echo "No such file: $tarfile" >&2; exit 1; }

# Stop the app first — restoring under a live writer would corrupt the DB.
docker compose down

# One-off container against the same volume: clear current state (including
# stale WAL/SHM, which would otherwise shadow the restored file), untar, and
# move the snapshot into place.
docker compose run --rm --no-deps -T --entrypoint sh app -c '
  set -eu
  rm -rf /data/images /data/coop.db /data/coop.db-wal /data/coop.db-shm
  tar -C /data -xf -
  mv /data/coop-backup.db /data/coop.db
' < "$tarfile"

echo "Restored $tarfile"
echo "Start the stack again with: docker compose up -d --wait"

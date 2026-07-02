#!/bin/sh
# Back up the coop's data (SPEC §6, blueprint 04 §5): one tar containing a
# consistent SQLite snapshot plus the images tree. Safe while the app is
# running — the snapshot uses SQLite's online backup API (via better-sqlite3,
# already in the image), never a raw copy of a live WAL database.
#
# Ordering matters: the app deletes image files at runtime (receipt-photo
# removal, draft abandon), so the images tree is archived FIRST and the DB
# snapshot taken AFTER. That way an image deleted in the gap was deleted by a
# DB write the later snapshot already contains — the restored DB never
# references a missing file. (An image ADDED in the gap is at worst a harmless
# orphan file in the archive.) The temp files live in the container and are
# removed even when a step fails.
#
# Usage: scripts/backup.sh [output-dir]     (default: ./backups)
# Restore with scripts/restore.sh — see README "Backups".
set -eu

out_dir=${1:-backups}
stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "$out_dir"

# Stream into a temp name and mv at the end: a backup that exists under its
# final name is always complete, never a partial archive from a failed run.
host_tmp="$out_dir/.coop-$stamp.partial"
trap 'rm -f "$host_tmp"' EXIT

docker compose exec -T app sh -c '
  set -eu
  tmp_tar=/data/.coop-backup-$$.tar
  tmp_db=/data/coop-backup.db
  trap "rm -f \"$tmp_tar\" \"$tmp_db\"" EXIT
  # 1) Images first (see header comment). mkdir -p keeps a fresh deployment
  #    with no uploads yet backupable.
  mkdir -p /data/images
  tar -C /data -cf "$tmp_tar" images
  # 2) Consistent point-in-time DB snapshot, taken after the images were read.
  node -e "
    const src = process.env.DATABASE_URL.replace(/^file:/, \"\");
    require(\"better-sqlite3\")(src)
      .backup(\"$tmp_db\")
      .then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  "
  # 3) Append the snapshot and stream the finished archive to the host.
  tar -C /data -rf "$tmp_tar" coop-backup.db
  cat "$tmp_tar"
' > "$host_tmp"

mv "$host_tmp" "$out_dir/coop-$stamp.tar"
echo "Wrote $out_dir/coop-$stamp.tar"

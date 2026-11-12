#!/bin/sh
# Restore a dump made by pg-backup.sh into the database the libpq variables point at.
# Stop api, worker and beat first (docs/DEPLOYMENT.md, "Restore").
#
#   pg-restore.sh /backups/ri-YYYYMMDDTHHMMSSZ.dump
set -eu
dump=${1:?usage: pg-restore.sh /backups/ri-<timestamp>.dump}
[ -f "$dump" ] || { echo "no such file: $dump" >&2; exit 1; }
if [ -f "$dump.sha256" ]; then
  (cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256")
fi
pg_restore --list "$dump" >/dev/null
echo "restoring $dump into ${PGDATABASE:-?}@${PGHOST:-?} (existing objects are dropped first)"
pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error \
  --dbname="${PGDATABASE:?}" "$dump"
echo "restore complete; start api (it runs alembic upgrade head), worker and beat"

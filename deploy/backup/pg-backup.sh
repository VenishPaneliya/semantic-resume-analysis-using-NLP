#!/bin/sh
# Scheduled PostgreSQL backups for the production compose stack (service `db-backup`).
#
#   pg-backup.sh            loop: back up daily at BACKUP_TIME (UTC), and at start if the newest backup is
#                           older than a day; delete dumps older than BACKUP_KEEP_DAYS after each success
#   pg-backup.sh once       one backup now (e.g. before an upgrade)
#   pg-backup.sh check      healthcheck: a successful backup within the last 26 hours
#
# Connection comes from the standard libpq variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE).
# Dumps are custom-format (`pg_dump -Fc`), verified with `pg_restore --list` before they are kept,
# and written to BACKUP_DIR (a Docker volume). Copy them off the host: see docs/DEPLOYMENT.md.
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_TIME=${BACKUP_TIME:-02:30}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
STAMP="$BACKUP_DIR/.last-success"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) pg-backup: $*"; }

backup_once() {
  mkdir -p "$BACKUP_DIR"
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  out="$BACKUP_DIR/ri-$ts.dump"
  tmp="$BACKUP_DIR/.ri-$ts.dump.partial"
  log "starting backup of ${PGDATABASE:-?}@${PGHOST:-?}"
  if ! pg_dump --format=custom --no-owner --no-privileges --file="$tmp"; then
    rm -f "$tmp"; log "FAILED: pg_dump"; return 1
  fi
  if ! pg_restore --list "$tmp" >/dev/null; then
    rm -f "$tmp"; log "FAILED: the dump is not readable"; return 1
  fi
  mv "$tmp" "$out"
  (cd "$BACKUP_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")
  date -u +%s > "$STAMP"
  log "ok: $out ($(wc -c < "$out") bytes)"
  # retention: only after a successful backup, so a failing job never empties the directory
  find "$BACKUP_DIR" -maxdepth 1 -name 'ri-*.dump*' -mtime +"$BACKUP_KEEP_DAYS" -print -exec rm -f {} + \
    | sed 's/^/pg-backup: expired /'
}

last_success_age() {
  if [ -s "$STAMP" ]; then echo $(( $(date -u +%s) - $(cat "$STAMP") )); else echo 999999999; fi
}

seconds_until_next_run() {
  now=$(date -u +%s)
  target=$(date -u -d "$(date -u +%Y-%m-%d) $BACKUP_TIME" +%s)
  [ "$target" -gt "$now" ] || target=$((target + 86400))
  echo $((target - now))
}

case "${1:-loop}" in
  once) backup_once ;;
  check) [ "$(last_success_age)" -lt $((26 * 3600)) ] ;;
  loop)
    log "schedule: daily at $BACKUP_TIME UTC, keep $BACKUP_KEEP_DAYS days, dir $BACKUP_DIR"
    if [ "$(last_success_age)" -ge 86400 ]; then
      until pg_isready -q; do sleep 5; done
      backup_once || true
    fi
    while :; do
      sleep "$(seconds_until_next_run)"
      # one retry after 10 minutes; the healthcheck turns unhealthy if both fail
      backup_once || { sleep 600; backup_once || true; }
    done
    ;;
  *) echo "usage: $0 [loop|once|check]" >&2; exit 2 ;;
esac

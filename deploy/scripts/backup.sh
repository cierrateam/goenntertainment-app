#!/usr/bin/env bash
# Nightly backup of the database and the uploads (F-17). Runs as the `backup` service of
# deploy/docker-compose.yml, in the MySQL image (it has bash, mysqldump, gzip, tar, sha256sum and
# GNU find and date; it has no flock, so the lock is a directory).
#
#   backup.sh                       daemon: one run at start (--at-start), then one every day at
#                                   02:30 UTC (--once)
#   backup.sh --once                one run now; exit 0 = a complete, verified set was written
#                                   (each run first waits up to about 5 minutes for the database);
#                                   then it deletes old sets
#   backup.sh --at-start            the daemon's run at start: as --once, but it deletes nothing
#   backup.sh --check               healthcheck: exit 0 when the last run succeeded within 26 hours
#                                   and no run failed since
#   backup.sh --seconds-until-next  the seconds until the next nightly run (BACKUP_NOW, a time in
#                                   UTC such as 2026-01-01T01:00:00Z, replaces the clock: tests)
#
# Each run writes one set into /backups (the operator's BACKUP_DIR):
#   db-<stamp>.sql.gz         a mysqldump of the database (one consistent transaction)
#   uploads-<stamp>.tar.gz    the public uploads and the private media (evidence, stories)
#   SHA256SUMS-<stamp>        the checksums of both
# The set is put together in .partial-<stamp>, checked (gzip -t, the dump's completion line,
# tar -t, the checksums) and only then moved into /backups. Only after that, in a nightly run and in
# a run by hand, are old sets deleted: a set's three files go or stay together; the newest
# BACKUP_RETENTION_DAYS sets (by the stamp in their names) stay whatever their age; of the older
# sets, those older than BACKUP_RETENTION_DAYS days go. With one set a night that is the same as
# deleting by age. The run at start deletes nothing, however often the service starts: a server
# restored from an old copy of its disk boots with every service running, and the sets that copy
# holds must stay until someone has picked one; the next nightly run keeps the newest
# BACKUP_RETENTION_DAYS sets. A failed run deletes nothing, records .last-failure and exits
# non-zero; the healthcheck then reports the service as unhealthy.
#
# Secrets: the database password reaches mysqldump through an option file in /tmp (a tmpfs),
# written by the shell's builtin printf, so it is on no command line and in no log.
set -Eeuo pipefail
umask 077

readonly BACKUP_ROOT=/backups
readonly DATA_ROOT=/data
# The folders under DATA_ROOT that go into the uploads archive (read-only mounts, see the compose).
readonly UPLOAD_DIRS=(uploads private-media)
# The nightly run in UTC. A technical constant: change it here if the operator wants another time.
readonly RUN_AT_UTC='02:30'
# --check: a backup older than this is overdue (one day plus time for a slow run).
readonly MAX_AGE_SECONDS=$((26 * 3600))
# A lock older than this belongs to a run that died; it is removed.
readonly STALE_LOCK_SECONDS=$((6 * 3600))
# The accepted BACKUP_RETENTION_DAYS: whole days, at least 1. Named mirror: deploy/scripts/
# preflight.sh checks the same pattern (deploy/test/static.test.mjs compares both).
readonly RETENTION_PATTERN='^[1-9][0-9]{0,4}$'
# The stamp a run puts into the names of its files (STAMP in run_once); prune orders sets by it.
readonly STAMP_PATTERN='^[0-9]{8}T[0-9]{6}Z$'
readonly CLIENT_CNF=/tmp/backup-client.cnf
readonly LIST_FILE=/tmp/backup-list
# Before each run: wait for the database, at most this many tries this many seconds apart. After a
# host reboot or an engine restart Docker starts db and backup at the same time (depends_on applies
# to `docker compose up` only), and the run at start would find MySQL still starting.
readonly DB_WAIT_TRIES=60
readonly DB_WAIT_STEP_SECONDS=5

RETENTION_DAYS=''
# 1: the run deletes old sets after its own (--once); 0: it deletes nothing (--at-start).
PRUNE_AFTER=1
LOCK_HELD=0
PARTIAL=''
STAMP=''

log() { printf 'backup: %s\n' "$*"; }
fail() { printf 'backup: ERROR: %s\n' "$*" >&2; }

# Exits with code 2 when a setting is missing or invalid. Names only, never values.
validate_settings() {
  local name missing=()
  if [[ ! "${BACKUP_RETENTION_DAYS:-}" =~ $RETENTION_PATTERN ]]; then
    fail 'BACKUP_RETENTION_DAYS must be a whole number of days, at least 1 (see deploy/.env.example)'
    exit 2
  fi
  for name in DB_HOST DB_DATABASE DB_USERNAME DB_PASSWORD; do
    [[ -n "${!name:-}" ]] || missing+=("$name")
  done
  if (( ${#missing[@]} > 0 )); then
    fail "missing settings: ${missing[*]}"
    exit 2
  fi
  RETENTION_DAYS=$BACKUP_RETENTION_DAYS
}

seconds_until_next() {
  local now today target
  if [[ -n "${BACKUP_NOW:-}" ]]; then
    now=$(date -u -d "$BACKUP_NOW" +%s)
  else
    now=$(date -u +%s)
  fi
  today=$(date -u -d "@$now" +%F)
  target=$(date -u -d "$today $RUN_AT_UTC:00" +%s)
  if (( target <= now )); then
    target=$((target + 86400))
  fi
  echo $((target - now))
}

check() {
  local now success failure
  now=$(date -u +%s)
  if [[ ! -f "$BACKUP_ROOT/.last-success" ]]; then
    echo 'backup: no successful run yet'
    return 1
  fi
  success=$(stat -c %Y "$BACKUP_ROOT/.last-success")
  if (( now - success > MAX_AGE_SECONDS )); then
    echo 'backup: the last successful run is older than 26 hours'
    return 1
  fi
  if [[ -f "$BACKUP_ROOT/.last-failure" ]]; then
    failure=$(stat -c %Y "$BACKUP_ROOT/.last-failure")
    if (( failure > success )); then
      echo 'backup: the last run failed'
      return 1
    fi
  fi
  echo 'backup: the last run succeeded'
}

acquire_lock() {
  local lock="$BACKUP_ROOT/.lock" age
  if ! mkdir "$lock" 2>/dev/null; then
    age=$(( $(date -u +%s) - $(stat -c %Y "$lock") ))
    if (( age < STALE_LOCK_SECONDS )); then
      fail "another run holds $lock (started ${age}s ago)"
      return 1
    fi
    log "removing the lock of a run that died ${age}s ago"
    rmdir "$lock"
    mkdir "$lock"
  fi
  LOCK_HELD=1
}

release_lock() {
  if [[ "$LOCK_HELD" == 1 ]]; then
    rmdir "$BACKUP_ROOT/.lock" 2>/dev/null || true
    LOCK_HELD=0
  fi
}

# The mysql client option file. Values are quoted, with backslash and double quote escaped, so
# any password works; printf is a shell builtin, so the password is on no command line.
write_client_cnf() {
  local password=${DB_PASSWORD//\\/\\\\}
  password=${password//\"/\\\"}
  printf '[client]\nhost="%s"\nport="%s"\nuser="%s"\npassword="%s"\n' \
    "$DB_HOST" "${DB_PORT:-3306}" "$DB_USERNAME" "$password" > "$CLIENT_CNF"
}

# Waits until the database answers. No credentials: mysqladmin ping exits 0 as soon as the server
# answers, even when it refuses the login (the db healthcheck relies on the same), so a wrong
# password still fails at mysqldump right away. Short steps keep a stop within Docker's grace time.
wait_for_db() {
  local try
  for (( try = 1; try <= DB_WAIT_TRIES; try++ )); do
    if mysqladmin ping -h "$DB_HOST" -P "${DB_PORT:-3306}" --connect-timeout=5 --silent > /dev/null 2>&1; then
      if (( try > 1 )); then log "the database answered after $try tries"; fi
      return 0
    fi
    if (( try < DB_WAIT_TRIES )); then sleep "$DB_WAIT_STEP_SECONDS"; fi
  done
  fail "the database at $DB_HOST did not answer ($DB_WAIT_TRIES tries, $DB_WAIT_STEP_SECONDS s apart)"
  return 1
}

# The names of the files of the sets in /backups; find tests in the arguments narrow them down.
set_files() {
  find "$BACKUP_ROOT" -maxdepth 1 -type f \
    \( -name 'db-*.sql.gz' -o -name 'uploads-*.tar.gz' -o -name 'SHA256SUMS-*' \) "$@" -printf '%f\n'
}

# The stamp in a set file's name: db-<stamp>.sql.gz, uploads-<stamp>.tar.gz, SHA256SUMS-<stamp>.
stamp_of() {
  local name=$1
  name=${name#db-}
  name=${name#uploads-}
  name=${name#SHA256SUMS-}
  name=${name%.sql.gz}
  printf '%s' "${name%.tar.gz}"
}

# Runs only after a complete, verified set was written. A set is the files of one stamp, and they
# go or stay together. The newest RETENTION_DAYS sets, by stamp, stay whatever their age: after a
# restore of an old copy of the server's disk, the run at start must not delete the sets that copy
# holds. Of the older sets, one goes when all its files are older than RETENTION_DAYS days (the
# same measure as find -mmin always used). A file with another stamp form is no set of this
# script's: it goes by its own age.
prune() {
  local name stamp i
  local -A old=() files_of=() young=()
  local -a stamps=() deleted=()
  while IFS= read -r name; do old[$name]=1; done < <(set_files -mmin "+$((RETENTION_DAYS * 1440))")
  while IFS= read -r name; do
    stamp=$(stamp_of "$name")
    if [[ ! "$stamp" =~ $STAMP_PATTERN ]]; then
      if [[ -n "${old[$name]:-}" ]]; then
        rm -f -- "$BACKUP_ROOT/$name"
        deleted+=("$name")
      fi
      continue
    fi
    [[ -n "${files_of[$stamp]:-}" ]] || stamps+=("$stamp")
    files_of[$stamp]+="$name"$'\n'
    [[ -n "${old[$name]:-}" ]] || young[$stamp]=1
  done < <(set_files)
  if (( ${#stamps[@]} > 0 )); then
    mapfile -t stamps < <(printf '%s\n' "${stamps[@]}" | sort -r)
  fi
  for (( i = RETENTION_DAYS; i < ${#stamps[@]}; i++ )); do
    stamp=${stamps[$i]}
    [[ -z "${young[$stamp]:-}" ]] || continue
    while IFS= read -r name; do
      [[ -n "$name" ]] || continue
      rm -f -- "$BACKUP_ROOT/$name"
      deleted+=("$name")
    done <<< "${files_of[$stamp]}"
  done
  # Sets of runs that died while being put together.
  find "$BACKUP_ROOT" -maxdepth 1 -type d -name '.partial-*' -mmin +1440 -exec rm -rf -- {} +
  for name in "${deleted[@]}"; do log "deleted $name"; done
  log "pruned ${#deleted[@]} file(s) older than $RETENTION_DAYS day(s); the newest $RETENTION_DAYS set(s) stay whatever their age"
}

finish() {
  local status=$1
  rm -f "$CLIENT_CNF" "$LIST_FILE"
  if (( status != 0 )); then
    if [[ -n "$PARTIAL" && -d "$PARTIAL" ]]; then
      rm -rf -- "$PARTIAL"
    fi
    date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_ROOT/.last-failure" 2>/dev/null || true
    fail "run ${STAMP:-before start} failed (exit $status); nothing was deleted"
  fi
  release_lock
}

run_once() {
  local dir dump archive sums files tar_status=0
  if [[ ! -d "$BACKUP_ROOT" || ! -w "$BACKUP_ROOT" ]]; then
    fail "$BACKUP_ROOT is not a writable directory (BACKUP_DIR, see deploy/.env.example)"
    return 1
  fi
  for dir in "${UPLOAD_DIRS[@]}"; do
    if [[ ! -d "$DATA_ROOT/$dir" ]]; then
      fail "$DATA_ROOT/$dir is missing (see the backup service's volumes)"
      return 1
    fi
  done
  wait_for_db
  acquire_lock

  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  PARTIAL="$BACKUP_ROOT/.partial-$STAMP"
  dump="db-$STAMP.sql.gz"
  archive="uploads-$STAMP.tar.gz"
  sums="SHA256SUMS-$STAMP"
  log "run $STAMP started"
  mkdir "$PARTIAL"

  # The database first: then the archive holds every file the dump refers to, except files node
  # deleted in between (a replaced avatar, an expired story).
  write_client_cnf
  mysqldump --defaults-extra-file="$CLIENT_CNF" --single-transaction --no-tablespaces \
    --triggers --hex-blob --set-gtid-purged=OFF "$DB_DATABASE" | gzip -9 > "$PARTIAL/$dump"
  rm -f "$CLIENT_CNF"
  gzip -t "$PARTIAL/$dump"
  if ! gzip -dc "$PARTIAL/$dump" | tail -n 1 | grep -q '^-- Dump completed'; then
    fail 'the database dump has no completion line'
    return 1
  fi

  # The upload volumes are live: api adds and deletes files while tar reads them (uploads,
  # replaced images, pruned evidence, account deletions). GNU tar then exits 1 ("file changed as
  # we read it", "File removed before we read it"): the archive holds the files as tar found them
  # and is kept. 2 or more is a real error. Each --warning keyword is an option of its own: GNU
  # tar 1.34 refuses the comma form, and the keywords silence the messages, not the status.
  tar --warning=no-file-removed --warning=no-file-changed \
    -C "$DATA_ROOT" -czf "$PARTIAL/$archive" "${UPLOAD_DIRS[@]}" || tar_status=$?
  if (( tar_status > 1 )); then
    fail "archiving the uploads failed (tar exit $tar_status)"
    return 1
  fi
  if (( tar_status == 1 )); then
    log 'files were added or removed while the uploads were archived (tar exit 1); the archive is kept'
  fi
  tar -tzf "$PARTIAL/$archive" > "$LIST_FILE"
  files=$(grep -c -v '/$' "$LIST_FILE" || true)
  rm -f "$LIST_FILE"

  (cd "$PARTIAL" && sha256sum "$dump" "$archive" > "$sums" && sha256sum --check --quiet "$sums")
  mv "$PARTIAL/$dump" "$PARTIAL/$archive" "$PARTIAL/$sums" "$BACKUP_ROOT/"
  rmdir "$PARTIAL"
  PARTIAL=''
  date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_ROOT/.last-success"
  log "run $STAMP written: database dump $(stat -c %s "$BACKUP_ROOT/$dump") bytes, uploads archive with $files file(s), checksums verified"

  # Only after a complete, verified set, and never in the run at start.
  if [[ "$PRUNE_AFTER" == 1 ]]; then
    prune
  else
    log 'the run at start deletes nothing; the next nightly run deletes old sets'
  fi
}

# once 1: a run that deletes old sets after its own (--once); once 0: one that deletes nothing.
once() {
  PRUNE_AFTER=$1
  validate_settings
  trap 'finish $?' EXIT
  trap 'exit 143' TERM INT
  run_once
}

daemon() {
  local child='' wait_seconds
  validate_settings
  trap 'log "stopping"; [[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null; exit 0' TERM INT
  if [[ ! -d "$BACKUP_ROOT" || ! -w "$BACKUP_ROOT" ]]; then
    fail "$BACKUP_ROOT is not a writable directory (BACKUP_DIR, see deploy/.env.example)"
    exit 1
  fi
  # No run can be in progress when the container starts: what a stopped container left behind
  # (a lock, a half-written set) is removed.
  if [[ -d "$BACKUP_ROOT/.lock" ]]; then
    rmdir "$BACKUP_ROOT/.lock" && log 'removed the lock of an interrupted run'
  fi
  find "$BACKUP_ROOT" -maxdepth 1 -type d -name '.partial-*' -exec rm -rf -- {} +
  log "nightly at $RUN_AT_UTC UTC; sets are kept for $RETENTION_DAYS day(s), the newest $RETENTION_DAYS whatever their age; first run now, which deletes nothing"
  # The run at start deletes nothing; the nightly runs after it do.
  local mode=--at-start
  while true; do
    bash "$0" "$mode" &
    child=$!
    wait "$child" || log 'the run failed; the next one is scheduled as usual'
    child=''
    mode=--once
    wait_seconds=$(seconds_until_next)
    log "next run in ${wait_seconds}s"
    sleep "$wait_seconds" &
    wait $!
  done
}

case "${1:-}" in
  '') daemon ;;
  --once) once 1 ;;
  --at-start) once 0 ;;
  --check) check ;;
  --seconds-until-next) seconds_until_next ;;
  *)
    fail "unknown argument: $1 (allowed: --once, --at-start, --check, --seconds-until-next)"
    exit 2
    ;;
esac

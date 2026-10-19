#!/usr/bin/env bash
# Checks the production settings before the first start and before every update:
#
#   deploy/scripts/preflight.sh [env-file]     default: deploy/.env next to the compose file
#
# It reads the env file without running it (no `source`), prints one line per check and a
# total, and never prints a value. Exit 0 = every check passed, 1 = at least one failed.
#   - the env file exists and only its owner can read it (mode 600 or 400);
#   - no setting of the file is also set in this shell: docker compose would take the shell's
#     value instead of the file's;
#   - BACKUP_DIR is an absolute path to an existing directory OUTSIDE this clone (a fresh clone
#     or a `git clean` must never take the backups with it), owned by root with mode 700 (the
#     backup container writes as root without any capability);
#   - BACKUP_RETENTION_DAYS, MYSQL_BINLOG_RETENTION_DAYS, LOG_MAX_SIZE and LOG_MAX_FILES have a
#     valid form (the backup and db services check the first two again when they start);
#     LOG_MAX_FILES is at least 2: Docker's `local` log driver compresses the rotated files and
#     then refuses a single file, so with 1 no container would start;
#   - EVIDENCE_RETENTION_DAYS and TOKEN_RETENTION_DAYS are whole days (the scheduler's prune
#     refuses anything else), and PAYMENTS_MODE is `off` or `test` (Laravel would treat any other
#     value as off, without a word);
#   - MAIL_MAILER is `graph` or `smtp`, and the chosen way has what it needs: the managed
#     identity's client ID (a GUID) for graph, MAIL_HOST for smtp; MAIL_FROM_ADDRESS is an
#     address (the image's entrypoint refuses the same when api or the scheduler starts);
#   - docker compose renders the production compose with this file, so every required setting
#     is there.
set -Euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
deploy_dir=$(dirname -- "$here")
clone=$(dirname -- "$deploy_dir")
env_file=${1:-$deploy_dir/.env}

# Named mirrors: deploy/scripts/backup.sh (RETENTION_PATTERN) and deploy/scripts/db-entrypoint.sh
# (BINLOG_RETENTION_PATTERN) check the same values when their services start;
# deploy/test/static.test.mjs compares the patterns.
readonly RETENTION_PATTERN='^[1-9][0-9]{0,4}$'
readonly BINLOG_RETENTION_PATTERN='^([1-9][0-9]{0,3}|off)$'
# Docker's `local` log driver: a size with the unit k, m or g, and a number of files from 2 (the
# driver compresses rotated files and refuses compression with one file).
readonly LOG_SIZE_PATTERN='^[1-9][0-9]{0,5}[kmg]$'
readonly LOG_FILES_PATTERN='^([2-9]|[1-9][0-9]{1,2})$'
# The two modes of api/config/club.php (App\Support\Payments).
readonly PAYMENTS_PATTERN='^(off|test)$'
# The two ways mail goes out (api/config/mail.php; api/docker/entrypoint.sh refuses the rest), the
# managed identity's client ID (a GUID) and a sender address.
readonly MAILER_PATTERN='^(graph|smtp)$'
readonly GUID_PATTERN='^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
readonly ADDRESS_PATTERN='^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'

checks=0
failed=0
pass() { checks=$((checks + 1)); printf 'ok    %s\n' "$1"; }
flunk() { checks=$((checks + 1)); failed=$((failed + 1)); printf 'FAIL  %s\n' "$1"; }
finish() {
  printf 'preflight: %d checks, %d failed\n' "$checks" "$failed"
  if (( checks == 0 || failed > 0 )); then exit 1; fi
  exit 0
}

# The names assigned in the env file (NAME=value lines).
names() {
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]]; then printf '%s\n' "${BASH_REMATCH[1]}"; fi
  done < "$env_file"
}

# The value of NAME in the env file: the last assignment wins, as in docker compose; surrounding
# quotes and a carriage return are removed. Empty when unset.
setting() {
  local line value=''
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    if [[ "$line" == "$1="* ]]; then value=${line#"$1="}; fi
  done < "$env_file"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value=${BASH_REMATCH[1]}; fi
  printf '%s' "$value"
}

if [[ ! -f "$env_file" ]]; then
  flunk "the env file exists (copy deploy/.env.example to deploy/.env and fill it in)"
  finish
fi
pass 'the env file exists'

mode=$(stat -c %a -- "$env_file")
if [[ "$mode" == 600 || "$mode" == 400 ]]; then
  pass 'only the owner can read the env file'
else
  flunk "only the owner can read the env file (chmod 600 it; mode is $mode)"
fi

shadowed=()
count=0
while IFS= read -r name; do
  count=$((count + 1))
  if [[ -n "${!name+set}" ]]; then shadowed+=("$name"); fi
done < <(names | sort -u)
if (( count == 0 )); then
  flunk 'the env file assigns settings (it assigns none)'
elif (( ${#shadowed[@]} == 0 )); then
  pass "none of the env file's $count settings is also set in this shell"
else
  flunk "set in this shell as well, docker compose would use the shell's value (unset them): ${shadowed[*]}"
fi

backup_dir=$(setting BACKUP_DIR)
if [[ "$backup_dir" != /* ]]; then
  flunk 'BACKUP_DIR is an absolute path'
elif [[ ! -d "$backup_dir" ]]; then
  flunk 'BACKUP_DIR is an existing directory (create it: install -d -m 700 -o root -g root <path>)'
else
  pass 'BACKUP_DIR is an existing directory with an absolute path'
  real=$(realpath -e -- "$backup_dir")
  if [[ "$real" == "$clone" || "$real" == "$clone"/* ]]; then
    flunk 'BACKUP_DIR lies outside this clone'
  else
    pass 'BACKUP_DIR lies outside this clone'
  fi
  owner_mode=$(stat -c '%u %a' -- "$real")
  if [[ "$owner_mode" == '0 700' ]]; then
    pass 'BACKUP_DIR belongs to root with mode 700'
  else
    flunk "BACKUP_DIR belongs to root with mode 700 (it has uid and mode $owner_mode)"
  fi
fi

valid() {
  local name=$1 pattern=$2 rule=$3
  if [[ "$(setting "$name")" =~ $pattern ]]; then
    pass "$name has a valid form"
  else
    flunk "$name has a valid form: $rule"
  fi
}
valid BACKUP_RETENTION_DAYS "$RETENTION_PATTERN" 'whole days, at least 1'
valid MYSQL_BINLOG_RETENTION_DAYS "$BINLOG_RETENTION_PATTERN" 'whole days from 1 to 9999, or off'
valid LOG_MAX_SIZE "$LOG_SIZE_PATTERN" 'a size such as 10m (unit k, m or g)'
valid LOG_MAX_FILES "$LOG_FILES_PATTERN" 'a number of files, at least 2'
valid EVIDENCE_RETENTION_DAYS "$RETENTION_PATTERN" 'whole days, at least 1'
valid TOKEN_RETENTION_DAYS "$RETENTION_PATTERN" 'whole days, at least 1'
valid PAYMENTS_MODE "$PAYMENTS_PATTERN" 'off or test'

# Mail (deploy/README.md, Settings): one way, and what that way needs; nothing falls back.
mailer=$(setting MAIL_MAILER)
valid MAIL_MAILER "$MAILER_PATTERN" 'graph or smtp (never log: it would write every code into the container log)'
if [[ "$mailer" == graph ]]; then
  valid MAIL_GRAPH_CLIENT_ID "$GUID_PATTERN" "the managed identity's client ID, a GUID (MAIL_MAILER=graph)"
elif [[ "$mailer" == smtp ]]; then
  if [[ -n "$(setting MAIL_HOST)" ]]; then
    pass 'MAIL_HOST is set (MAIL_MAILER=smtp)'
  else
    flunk 'MAIL_HOST is set (MAIL_MAILER=smtp)'
  fi
fi
valid MAIL_FROM_ADDRESS "$ADDRESS_PATTERN" 'an e-mail address: the sender mailbox'

if docker compose --project-directory "$deploy_dir" --env-file "$env_file" \
  -f "$deploy_dir/docker-compose.yml" config --quiet; then
  pass 'docker compose renders the production compose with the env file'
else
  flunk 'docker compose renders the production compose with the env file (its message above names the missing setting, only the first one with an older docker compose: run the preflight again until it passes)'
fi

finish

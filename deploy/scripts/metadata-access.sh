#!/usr/bin/env bash
# Lets api and the scheduler, and no other container, reach the server's metadata endpoint
# (169.254.169.254), where the graph mailer gets its token for the managed identity
# (deploy/README.md, Mail through Microsoft Graph). Runs as root on the host, once Docker runs:
#
#   deploy/scripts/metadata-access.sh [env-file]     default: deploy/.env next to the compose file
#
# The hosting platform drops all container traffic to 169.254.169.254 (a rule at the end of
# Docker's DOCKER-USER chain, applied again after every reboot and Docker restart). This script
# inserts one ACCEPT rule per service at the top of DOCKER-USER: from api's and the scheduler's
# fixed addresses (docker-compose.yml: <APP_NET_PREFIX>.20 on edge, <APP_NET_PREFIX>.140 on
# outbound), each a single address (/32), to 169.254.169.254/32, TCP port 80. A rule that is there
# already stays as it is, so a second run adds nothing. It prints each rule as found or added
# (addresses only), and changes nothing when APP_NET_PREFIX is missing or malformed or when
# DOCKER-USER does not exist (Docker is not running). deploy/systemd/goenn-metadata-access.service
# runs it at every boot and every Docker restart.
set -Euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
deploy_dir=$(dirname -- "$here")
env_file=${1:-$deploy_dir/.env}

# Three numbers from 0 to 255, without leading zeros: the first three parts of the stack's /24.
# Named mirror: deploy/scripts/preflight.sh checks the same pattern; deploy/test/static.test.mjs
# compares them.
readonly NET_PREFIX_PATTERN='^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){2}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$'
readonly METADATA='169.254.169.254'
# The last part of api's and the scheduler's fixed addresses (docker-compose.yml).
readonly HOSTS=(20 140)

# The value of NAME in the env file, read without running it, as the preflight reads it.
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
  echo "metadata-access: no env file at $env_file; nothing changed" >&2
  exit 1
fi
prefix=$(setting APP_NET_PREFIX)
if [[ ! "$prefix" =~ $NET_PREFIX_PATTERN ]]; then
  echo 'metadata-access: APP_NET_PREFIX is missing or not three numbers from 0 to 255 (deploy/.env); nothing changed' >&2
  exit 1
fi
if ! iptables -n -L DOCKER-USER >/dev/null 2>&1; then
  echo 'metadata-access: the chain DOCKER-USER does not exist (is Docker running?); nothing changed' >&2
  exit 1
fi

for host in "${HOSTS[@]}"; do
  rule=(-s "$prefix.$host/32" -d "$METADATA/32" -p tcp --dport 80 -m comment --comment goenn-metadata -j ACCEPT)
  if iptables -C DOCKER-USER "${rule[@]}" 2>/dev/null; then
    echo "found: $prefix.$host -> $METADATA:80"
  elif iptables -I DOCKER-USER 1 "${rule[@]}"; then
    echo "added: $prefix.$host -> $METADATA:80"
  else
    echo "metadata-access: could not add the rule for $prefix.$host" >&2
    exit 1
  fi
done

#!/usr/bin/env bash
# Season 2 auction monitor. Designed for cron (e.g. every minute during the sale):
#   * * * * * RPC_URL=... AUCTION=0x... DISCORD_WEBHOOK_URL=... /path/to/monitor-auction.sh
#
# Keeps a strictly parsed previous snapshot in $STATE_FILE and posts a Discord message when:
#   - the phase changes (Active/Finalizing/Settled/Cancelled)
#   - pause flips
#   - a supply mismatch is detected              (critical)
#   - settlement has ended with minting authorization/capability unavailable
#   - the contract balance drops below tracked liabilities (critical, should be impossible)
#   - the end time moves (anti-snipe extension)
#   - bidding enters the final 15 minutes
#
# Run with --healthcheck to validate dependencies, configuration, RPC reads, and (when configured)
# webhook delivery without changing monitor state.
#
# Requires: bash 4+, cast (Foundry), curl, timeout, flock, and GNU coreutils.
# Does not require bc or jq.
set -euo pipefail
LC_ALL=C
umask 077

PROGRAM=${0##*/}
MODE="${1:-run}"
if [[ "$MODE" != "run" && "$MODE" != "--healthcheck" ]]; then
  printf 'Usage: %s [--healthcheck]\n' "$PROGRAM" >&2
  exit 2
fi

die() {
  printf '%s: %s\n' "$PROGRAM" "$1" >&2
  exit 1
}

for dependency in cast curl timeout flock date mkdir dirname mktemp mv chmod stat; do
  command -v "$dependency" >/dev/null 2>&1 || die "required command not found: $dependency"
done

: "${RPC_URL:?RPC_URL is required}"
: "${AUCTION:?AUCTION is required}"
DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"
RPC_TIMEOUT_SECONDS="${RPC_TIMEOUT_SECONDS:-15}"
WEBHOOK_CONNECT_TIMEOUT_SECONDS="${WEBHOOK_CONNECT_TIMEOUT_SECONDS:-5}"
WEBHOOK_MAX_TIME_SECONDS="${WEBHOOK_MAX_TIME_SECONDS:-10}"

[[ "$RPC_URL" =~ ^https?://[^[:space:]]+$ ]] || die "RPC_URL must be an HTTP(S) URL without whitespace"
[[ "$AUCTION" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "AUCTION must be a 20-byte hex address"
[[ "$AUCTION" != "0x0000000000000000000000000000000000000000" ]] || die "AUCTION cannot be the zero address"
if [[ -n "$DISCORD_WEBHOOK_URL" ]]; then
  [[ "$DISCORD_WEBHOOK_URL" =~ ^https?://[^[:space:]]+$ ]] \
    || die "DISCORD_WEBHOOK_URL must be an HTTP(S) URL without whitespace"
fi

bounded_small_uint() {
  local name=$1 value=$2 minimum=$3 maximum=$4
  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be an integer"
  ((${#value} <= 3 && 10#$value >= minimum && 10#$value <= maximum)) \
    || die "$name must be between $minimum and $maximum"
}

bounded_small_uint RPC_TIMEOUT_SECONDS "$RPC_TIMEOUT_SECONDS" 1 120
bounded_small_uint WEBHOOK_CONNECT_TIMEOUT_SECONDS "$WEBHOOK_CONNECT_TIMEOUT_SECONDS" 1 60
bounded_small_uint WEBHOOK_MAX_TIME_SECONDS "$WEBHOOK_MAX_TIME_SECONDS" 1 120

STATE_FILE_WAS_DEFAULT=0
if [[ -z "${STATE_FILE:-}" ]]; then
  STATE_FILE_WAS_DEFAULT=1
  if [[ -n "${XDG_STATE_HOME:-}" ]]; then
    STATE_FILE="$XDG_STATE_HOME/panorama-auction/monitor.state"
  elif [[ -n "${HOME:-}" ]]; then
    STATE_FILE="$HOME/.local/state/panorama-auction/monitor.state"
  else
    STATE_FILE="${TMPDIR:-/tmp}/panorama-auction-monitor-${UID}/monitor.state"
  fi
fi

STATE_DIR=$(dirname -- "$STATE_FILE")
mkdir -p -- "$STATE_DIR"
if ((STATE_FILE_WAS_DEFAULT)); then
  chmod 700 -- "$STATE_DIR"
fi

[[ -d "$STATE_DIR" && -O "$STATE_DIR" ]] || die "state directory must be owned by the monitor user"
STATE_DIR_MODE=$(stat -c '%a' -- "$STATE_DIR")
[[ "$STATE_DIR_MODE" =~ ^[0-7]{3,4}$ ]] || die "could not validate state directory permissions"
(( (8#$STATE_DIR_MODE & 0022) == 0 )) || die "state directory must not be group/world writable"
[[ ! -L "$STATE_FILE" ]] || die "STATE_FILE must not be a symbolic link"
if [[ -e "$STATE_FILE" ]]; then
  [[ -f "$STATE_FILE" && -O "$STATE_FILE" ]] || die "STATE_FILE must be a regular file owned by the monitor user"
  chmod 600 -- "$STATE_FILE"
fi

LOCK_FILE="${STATE_FILE}.lock"
[[ ! -L "$LOCK_FILE" ]] || die "monitor lock must not be a symbolic link"
exec 9>"$LOCK_FILE"
chmod 600 -- "$LOCK_FILE"
if ! flock -n 9; then
  printf '%s: another monitor process is already running\n' "$PROGRAM" >&2
  exit 0
fi

is_uint() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

normalize_uint() {
  local value=$1
  is_uint "$value" || return 1
  while ((${#value} > 1)) && [[ "${value:0:1}" == "0" ]]; do
    value=${value:1}
  done
  printf '%s' "$value"
}

# Arbitrary-size unsigned integer comparison without bc or shell arithmetic overflow.
uint_lt() {
  local left right
  left=$(normalize_uint "$1") || return 2
  right=$(normalize_uint "$2") || return 2
  if ((${#left} != ${#right})); then
    ((${#left} < ${#right}))
  else
    [[ "$left" < "$right" ]]
  fi
}

uint_le() {
  [[ "$(normalize_uint "$1")" == "$(normalize_uint "$2")" ]] || uint_lt "$1" "$2"
}

rpc_call() {
  local signature=$1 raw value remainder
  if ! raw=$(timeout "${RPC_TIMEOUT_SECONDS}s" cast call "$AUCTION" "$signature" --rpc-url "$RPC_URL" 2>/dev/null); then
    die "RPC call failed or timed out: $signature"
  fi
  read -r value remainder <<<"$raw"
  [[ -n "$value" ]] || die "RPC returned an empty value: $signature"
  printf '%s' "$value"
}

call_uint() {
  local signature=$1 value
  value=$(rpc_call "$signature")
  is_uint "$value" || die "RPC returned a non-integer value: $signature"
  printf '%s' "$value"
}

call_bool() {
  local signature=$1 value
  value=$(rpc_call "$signature")
  [[ "$value" == "true" || "$value" == "false" ]] || die "RPC returned a non-boolean value: $signature"
  printf '%s' "$value"
}

PHASE=$(call_uint 'phase()(uint8)')
((10#$PHASE <= 3)) || die "phase() returned an unknown phase"
PAUSED=$(call_bool 'paused()(bool)')
END=$(call_uint 'endTime()(uint64)')
BIDS=$(call_uint 'activeBids()(uint256)')
FLOOR=$(call_uint 'currentClearingPrice()(uint256)')
MISMATCH=$(call_bool 'supplyMismatched()(bool)')
MINTING_UNAVAILABLE=$(call_bool 'mintingUnavailable()(bool)')
LIAB=$(call_uint 'totalLiabilities()(uint256)')

if ! BAL_RAW=$(timeout "${RPC_TIMEOUT_SECONDS}s" cast balance "$AUCTION" --rpc-url "$RPC_URL" 2>/dev/null); then
  die "RPC balance read failed or timed out"
fi
read -r BAL _ <<<"$BAL_RAW"
is_uint "$BAL" || die "RPC returned a non-integer balance"

NOW=$(date -u +%s)
is_uint "$NOW" || die "system clock returned an invalid timestamp"

case "$PHASE" in
  0) PHASE_NAME=Active ;;
  1) PHASE_NAME=Finalizing ;;
  2) PHASE_NAME=Settled ;;
  3) PHASE_NAME=Cancelled ;;
esac

eth_value() {
  local value=$1 converted
  if converted=$(cast from-wei "$value" 2>/dev/null); then
    printf '%s' "$converted"
  else
    printf '%s wei' "$value"
  fi
}

WEBHOOK_FAILED=0
send_webhook() {
  local message=$1 escaped payload http_code curl_status
  escaped=${message//\\/\\\\}
  escaped=${escaped//\"/\\\"}
  payload=$(printf '{"content":"%s"}' "$escaped")

  if http_code=$(curl --fail-with-body --silent --show-error \
      --connect-timeout "$WEBHOOK_CONNECT_TIMEOUT_SECONDS" \
      --max-time "$WEBHOOK_MAX_TIME_SECONDS" \
      -X POST -H 'Content-Type: application/json' \
      --data "$payload" -o /dev/null -w '%{http_code}' \
      "$DISCORD_WEBHOOK_URL" 2>/dev/null); then
    return 0
  else
    curl_status=$?
  fi

  printf '%s: webhook delivery failed (curl exit %s, HTTP %s)\n' \
    "$PROGRAM" "$curl_status" "${http_code:-000}" >&2
  WEBHOOK_FAILED=1
  return 0
}

alert() {
  local message="[panorama-auction] $1"
  printf '%s\n' "$message"
  if [[ -n "$DISCORD_WEBHOOK_URL" ]]; then
    send_webhook "$message"
  fi
}

if [[ "$MODE" == "--healthcheck" ]]; then
  alert "healthcheck OK: RPC reads valid; phase=$PHASE ($PHASE_NAME), bids=$BIDS, liabilities=$LIAB wei."
  ((WEBHOOK_FAILED == 0)) || exit 1
  exit 0
fi

PREV_PHASE=""
PREV_PAUSED=""
PREV_END=""
PREV_NEAR=""

load_state() {
  [[ -e "$STATE_FILE" ]] || return 0

  local line key value
  declare -A seen=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^(PREV_PHASE|PREV_PAUSED|PREV_END|PREV_NEAR)=(.*)$ ]] \
      || die "STATE_FILE contains an invalid line"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    [[ -z "${seen[$key]+present}" ]] || die "STATE_FILE contains a duplicate key"
    seen[$key]=1

    case "$key" in
      PREV_PHASE)
        [[ "$value" =~ ^[0-3]$ ]] || die "STATE_FILE contains an invalid PREV_PHASE"
        PREV_PHASE=$value
        ;;
      PREV_PAUSED)
        [[ "$value" == "true" || "$value" == "false" ]] \
          || die "STATE_FILE contains an invalid PREV_PAUSED"
        PREV_PAUSED=$value
        ;;
      PREV_END)
        is_uint "$value" || die "STATE_FILE contains an invalid PREV_END"
        PREV_END=$value
        ;;
      PREV_NEAR)
        [[ "$value" == "0" || "$value" == "1" ]] || die "STATE_FILE contains an invalid PREV_NEAR"
        PREV_NEAR=$value
        ;;
    esac
  done < "$STATE_FILE"
}

write_state() {
  local temporary
  temporary=$(mktemp "${STATE_FILE}.tmp.XXXXXX")
  chmod 600 -- "$temporary"
  trap 'rm -f -- "${temporary:-}"' RETURN
  printf 'PREV_PHASE=%s\nPREV_PAUSED=%s\nPREV_END=%s\nPREV_NEAR=%s\n' \
    "$PHASE" "$PAUSED" "$END" "$NEAR" > "$temporary"
  mv -f -- "$temporary" "$STATE_FILE"
  trap - RETURN
}

load_state

if [[ -n "$PREV_PHASE" && "$PHASE" != "$PREV_PHASE" ]]; then
  alert "phase changed: $PREV_PHASE -> $PHASE ($PHASE_NAME). bids=$BIDS floor=$(eth_value "$FLOOR") ETH"
fi
if [[ -n "$PREV_PAUSED" && "$PAUSED" != "$PREV_PAUSED" ]]; then
  alert "paused changed: $PAUSED"
fi
if [[ "$MISMATCH" == "true" ]]; then
  alert "CRITICAL: supplyMismatched() is TRUE. Bidding/settlement fail closed; recovery is live on /recovery."
fi
if [[ "$MINTING_UNAVAILABLE" == "true" && ("$PHASE" == "0" || "$PHASE" == "1") ]] \
    && uint_le "$END" "$NOW"; then
  alert "CRITICAL: auction ended but minting is unavailable (authorization missing/revoked or cap insufficient). Fix settlement capability; permissionless recovery opens after the seven-day finalize grace."
fi
if uint_lt "$BAL" "$LIAB"; then
  alert "CRITICAL: balance $BAL < liabilities $LIAB (should be impossible; investigate immediately)"
fi
if [[ -n "$PREV_END" && "$END" != "$PREV_END" && "$PHASE" == "0" ]]; then
  FORMATTED_END=$(date -u -d "@$END" +%H:%M:%SZ 2>/dev/null || printf '%s' "$END")
  alert "anti-snipe extension: end moved to $FORMATTED_END. bids=$BIDS floor=$(eth_value "$FLOOR") ETH"
fi

NEAR=0
NEAR_CUTOFF=$((10#$NOW + 900))
if [[ "$PHASE" == "0" ]] && uint_lt "$NOW" "$END" && uint_le "$END" "$NEAR_CUTOFF"; then
  NEAR=1
fi
if [[ "$NEAR" == "1" && "$PREV_NEAR" != "1" ]]; then
  alert "final 15 minutes. bids=$BIDS floor=$(eth_value "$FLOOR") ETH"
fi

# Do not advance state after a delivery failure: the next cron run retries transition alerts.
if ((WEBHOOK_FAILED)); then
  die "one or more alerts could not be delivered; monitor state was not advanced"
fi

write_state

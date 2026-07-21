#!/usr/bin/env bash
# Discord alert on new/increased bids for the Season 2 auction. Companion to
# monitor-auction.sh (which alerts on phase/pause/extension/mismatch only).
# Cron (every minute):
#   * * * * * /path/to/bid-alert.sh >> ~/.local/state/panorama-auction/bid-alert.log 2>&1
#
# Posts one message per run when nextBidId or totalEscrowed changed, listing each
# new bid's amount and bidder (ENS name when one resolves, short address otherwise).
# Config mirrors monitor-auction.sh: AUCTION / DISCORD_WEBHOOK_URL / RPC_URL from
# the environment, falling back to values parsed (never sourced) from ../.env.
set -euo pipefail
LC_ALL=C
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

dotenv_lookup() {
  local file line
  file="$SCRIPT_DIR/../.env"
  [[ -f "$file" ]] || return 0
  line=$(grep -E "^${1}=" "$file" | tail -n 1) || return 0
  line=${line#*=}
  line=${line%$'\r'}
  line=${line#"${line%%[![:space:]]*}"}
  line=${line%"${line##*[![:space:]]}"}
  line=${line%\"}; line=${line#\"}
  line=${line%\'}; line=${line#\'}
  printf '%s' "$line"
}

AUCTION=${AUCTION:-$(dotenv_lookup PANORAMA_AUCTION_ADDRESS)}
DISCORD_WEBHOOK_URL=${DISCORD_WEBHOOK_URL:-$(dotenv_lookup DISCORD_WEBHOOK_URL)}
if [[ -z "${RPC_URL:-}" ]]; then
  key=${API_KEY_ALCHEMY:-$(dotenv_lookup API_KEY_ALCHEMY)}
  [[ -n "$key" ]] && RPC_URL="https://eth-mainnet.g.alchemy.com/v2/${key}"
fi
[[ -n "${AUCTION:-}" ]] || { echo "bid-alert: AUCTION not set" >&2; exit 1; }
[[ -n "${RPC_URL:-}" ]] || { echo "bid-alert: RPC_URL not set" >&2; exit 1; }
[[ -n "${DISCORD_WEBHOOK_URL:-}" ]] || { echo "bid-alert: DISCORD_WEBHOOK_URL not set" >&2; exit 1; }

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/panorama-auction"
STATE_FILE="$STATE_DIR/bid-alert.state"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

exec 9>"$STATE_FILE.lock"
flock -n 9 || exit 0

read_uint() {
  # cast prints "2641000000000000000 [2.641e18]" for big uints; keep field 1.
  cast call "$AUCTION" "$1" --rpc-url "$RPC_URL" | awk '{print $1}'
}

# Wei -> ETH with up to 4 decimals, trailing zeros trimmed ("6.1970" -> "6.197").
eth() {
  local wei=$1 sign=""
  if [[ "$wei" == -* ]]; then sign="-"; wei=${wei#-}; fi
  printf '%s%s' "$sign" "$(cast to-unit "$wei" ether | awk '{printf "%.4f", $1}' | sed -E 's/0+$//; s/\.$//')"
}

short_addr() { printf '%s..%s' "${1:0:6}" "${1: -4}"; }

# ENS reverse lookup with a hard timeout; falls back to the short address.
bidder_label() {
  local addr=$1 name
  if name=$(timeout 10 cast lookup-address "$addr" --rpc-url "$RPC_URL" 2>/dev/null) \
      && [[ -n "$name" && "$name" != *" "* ]]; then
    printf '%s' "$name"
  else
    short_addr "$addr"
  fi
}

NEXT_BID_ID=$(read_uint 'nextBidId()(uint32)')
ESCROWED=$(read_uint 'totalEscrowed()(uint256)')
ACTIVE=$(read_uint 'activeBids()(uint256)')
FLOOR=$(read_uint 'currentClearingPrice()(uint256)')
[[ "$NEXT_BID_ID" =~ ^[0-9]+$ && "$ESCROWED" =~ ^[0-9]+$ ]] || { echo "bid-alert: bad RPC read" >&2; exit 1; }

PREV_NEXT_BID_ID=""
PREV_ESCROWED=""
if [[ -f "$STATE_FILE" ]]; then
  PREV_NEXT_BID_ID=$(grep -E '^PREV_NEXT_BID_ID=[0-9]+$' "$STATE_FILE" | tail -n 1 | cut -d= -f2 || true)
  PREV_ESCROWED=$(grep -E '^PREV_ESCROWED=[0-9]+$' "$STATE_FILE" | tail -n 1 | cut -d= -f2 || true)
fi

save_state() {
  local tmp
  tmp=$(mktemp "$STATE_FILE.XXXXXX")
  printf 'PREV_NEXT_BID_ID=%s\nPREV_ESCROWED=%s\n' "$NEXT_BID_ID" "$ESCROWED" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$STATE_FILE"
}

# First run: record a baseline, no alert.
if [[ -z "$PREV_NEXT_BID_ID" || -z "$PREV_ESCROWED" ]]; then
  save_state
  exit 0
fi

NEW_BIDS=$(( NEXT_BID_ID - PREV_NEXT_BID_ID ))
ESCROW_DELTA=$(( ESCROWED - PREV_ESCROWED ))
if (( NEW_BIDS == 0 && ESCROW_DELTA == 0 )); then
  exit 0
fi

DETAIL_CAP=10
NL=$'\n'
MSG=""
if (( NEW_BIDS > 0 )); then
  if (( NEW_BIDS == 1 )); then MSG="New bid"; else MSG="${NEW_BIDS} new bids"; fi
  count=0
  for (( id = PREV_NEXT_BID_ID; id < NEXT_BID_ID; id++ )); do
    if (( count >= DETAIL_CAP )); then
      MSG="$MSG${NL}and $(( NEXT_BID_ID - id )) more"
      break
    fi
    line=$(cast call "$AUCTION" 'bids(uint32)(address,uint96)' "$id" --rpc-url "$RPC_URL" 2>/dev/null | paste -sd' ' -) || line=""
    bidder=$(awk '{print $1}' <<<"$line")
    amount=$(awk '{print $2}' <<<"$line")
    if [[ "$bidder" =~ ^0x[0-9a-fA-F]{40}$ && "$bidder" != 0x0000000000000000000000000000000000000000 && "$amount" =~ ^[0-9]+$ ]]; then
      MSG="$MSG${NL}$(eth "$amount") ETH from $(bidder_label "$bidder")"
    else
      MSG="$MSG${NL}bid #$id (already displaced or refunded)"
    fi
    (( ++count ))
  done
elif (( ESCROW_DELTA > 0 )); then
  MSG="Bid increased by $(eth "$ESCROW_DELTA") ETH"
else
  MSG="Escrow changed by $(eth "$ESCROW_DELTA") ETH"
fi
MSG="$MSG${NL}Active ${ACTIVE}/90, escrow $(eth "$ESCROWED") ETH, clearing floor $(eth "$FLOOR") ETH"

# JSON-escape backslashes, quotes, newlines.
esc=${MSG//\\/\\\\}
esc=${esc//\"/\\\"}
esc=${esc//$NL/\\n}

http_code=$(curl -sS -o /dev/null -w '%{http_code}' \
  --connect-timeout 5 --max-time 15 \
  -H 'Content-Type: application/json' \
  -d "{\"content\": \"$esc\"}" \
  "$DISCORD_WEBHOOK_URL") || { echo "bid-alert: webhook request failed" >&2; exit 1; }
if [[ "$http_code" != 2* ]]; then
  # State is NOT saved on webhook failure so the alert retries next run.
  echo "bid-alert: webhook HTTP $http_code" >&2
  exit 1
fi

save_state
printf 'posted:\n%s\n' "$MSG"

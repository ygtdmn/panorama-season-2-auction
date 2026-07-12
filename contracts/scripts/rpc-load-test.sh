#!/usr/bin/env bash
# Bounded, read-only load test for the auction frontend's Ethereum RPC access pattern.
#
# Required:
#   RPC_URL=https://...                  provider endpoint (never printed)
#   AUCTION=0x...                        deployed auction contract (omit in synthetic mode)
#
# Optional:
#   RPC_LOAD_REQUESTS=1                  simulated page-load snapshots (1..200)
#   RPC_LOAD_CONCURRENCY=1               concurrent snapshots (1..32)
#   RPC_LOAD_TIMEOUT_SECONDS=20          total timeout per HTTP request (1..120)
#   RPC_LOAD_CONNECT_TIMEOUT_SECONDS=5   connect timeout per HTTP request (1..60)
#   RPC_LOAD_ACCOUNT=0x...               account used for the three wallet-specific reads
#   RPC_LOAD_ENS_RESOLUTIONS=90          per-client ENS reverse lookups (0..90; worst-case board)
#   RPC_LOAD_ENS_CONCURRENCY=10          concurrent ENS reads per client (1..30)
#   RPC_LOAD_DEPLOY_BLOCK=123456          enables the settlement Won-event log query
#   RPC_LOAD_SYNTHETIC=1                 allow-failure Multicall3 against a placeholder target
#   MULTICALL_ADDRESS=0xcA11...CA11       Multicall3 deployment
#   ENS_RESOLVER_ADDRESS=0xeeee...eeee    ENS Universal Resolver used by viem/mainnet
#
# A snapshot models the frontend's block read, 40-call global Multicall3 snapshot, three-call
# account Multicall3 snapshot, up to 90 independent ENS reverse lookups, and optionally its
# bounded Won-event scan. The UI lazy-loads visible ENS rows; 90 is the full-board upper bound.
# The test never submits, signs, estimates, or simulates a transaction.
set -euo pipefail
LC_ALL=C
umask 077

PROGRAM=${0##*/}

die() {
  printf '%s: %s\n' "$PROGRAM" "$1" >&2
  exit 1
}

((BASH_VERSINFO[0] >= 4)) || die "bash 4 or newer is required"
for dependency in cast curl awk grep mktemp sort wc; do
  command -v "$dependency" >/dev/null 2>&1 || die "required command not found: $dependency"
done

: "${RPC_URL:?RPC_URL is required}"

REQUESTS="${RPC_LOAD_REQUESTS:-1}"
CONCURRENCY="${RPC_LOAD_CONCURRENCY:-1}"
REQUEST_TIMEOUT="${RPC_LOAD_TIMEOUT_SECONDS:-20}"
CONNECT_TIMEOUT="${RPC_LOAD_CONNECT_TIMEOUT_SECONDS:-5}"
ACCOUNT="${RPC_LOAD_ACCOUNT:-0x0000000000000000000000000000000000000000}"
ENS_RESOLUTIONS="${RPC_LOAD_ENS_RESOLUTIONS:-90}"
ENS_CONCURRENCY="${RPC_LOAD_ENS_CONCURRENCY:-10}"
DEPLOY_BLOCK="${RPC_LOAD_DEPLOY_BLOCK:-}"
SYNTHETIC="${RPC_LOAD_SYNTHETIC:-0}"
MULTICALL_ADDRESS="${MULTICALL_ADDRESS:-0xcA11bde05977b3631167028862bE2a173976CA11}"
ENS_RESOLVER_ADDRESS="${ENS_RESOLVER_ADDRESS:-0xeeeeeeee14d718c2b47d9923deab1335e144eeee}"

[[ "$SYNTHETIC" == "0" || "$SYNTHETIC" == "1" ]] || die "RPC_LOAD_SYNTHETIC must be 0 or 1"
if [[ "$SYNTHETIC" == "1" ]]; then
  AUCTION="${AUCTION:-0x000000000000000000000000000000000000dEaD}"
  ALLOW_FAILURE=true
else
  : "${AUCTION:?AUCTION is required unless RPC_LOAD_SYNTHETIC=1}"
  ALLOW_FAILURE=false
fi

[[ "$RPC_URL" =~ ^https?://[^[:space:]]+$ ]] || die "RPC_URL must be an HTTP(S) URL without whitespace"
for address_name in AUCTION ACCOUNT MULTICALL_ADDRESS ENS_RESOLVER_ADDRESS; do
  address_value=${!address_name}
  [[ "$address_value" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "$address_name must be a 20-byte hex address"
done
[[ "$AUCTION" != "0x0000000000000000000000000000000000000000" ]] || die "AUCTION cannot be the zero address"
[[ "$MULTICALL_ADDRESS" != "0x0000000000000000000000000000000000000000" ]] \
  || die "MULTICALL_ADDRESS cannot be the zero address"

bounded_uint() {
  local name=$1 value=$2 minimum=$3 maximum=$4
  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be an integer"
  ((${#value} <= 3 && 10#$value >= minimum && 10#$value <= maximum)) \
    || die "$name must be between $minimum and $maximum"
}

bounded_uint RPC_LOAD_REQUESTS "$REQUESTS" 1 200
bounded_uint RPC_LOAD_CONCURRENCY "$CONCURRENCY" 1 32
bounded_uint RPC_LOAD_TIMEOUT_SECONDS "$REQUEST_TIMEOUT" 1 120
bounded_uint RPC_LOAD_CONNECT_TIMEOUT_SECONDS "$CONNECT_TIMEOUT" 1 60
bounded_uint RPC_LOAD_ENS_RESOLUTIONS "$ENS_RESOLUTIONS" 0 90
bounded_uint RPC_LOAD_ENS_CONCURRENCY "$ENS_CONCURRENCY" 1 30
((10#$CONCURRENCY <= 10#$REQUESTS)) || die "RPC_LOAD_CONCURRENCY cannot exceed RPC_LOAD_REQUESTS"
if ((10#$ENS_RESOLUTIONS > 0)); then
  ((10#$ENS_CONCURRENCY <= 10#$ENS_RESOLUTIONS)) \
    || die "RPC_LOAD_ENS_CONCURRENCY cannot exceed RPC_LOAD_ENS_RESOLUTIONS"
fi

GLOBAL_SIGNATURES=(
  'phase()'
  'paused()'
  'startTime()'
  'endTime()'
  'reservePrice()'
  'minIncrementBps()'
  'extensionCount()'
  'MAX_UNITS()'
  'MAX_BIDS_PER_WALLET()'
  'activeBids()'
  'isFull()'
  'currentClearingPrice()'
  'lowestActiveBid()'
  'minimumBid()'
  'clearingPrice()'
  'proceeds()'
  'owner()'
  'payoutA()'
  'payoutB()'
  'getBids()'
  'absoluteEndTime()'
  'finalizeCursor()'
  'refundCursor()'
  'winnerCount()'
  'refundsComplete()'
  'totalEscrowed()'
  'totalPendingReturns()'
  'unreleasedProceeds()'
  'totalLiabilities()'
  'surplusETH()'
  'EMERGENCY_GRACE()'
  'FIRST_TOKEN_ID()'
  'LAST_TOKEN_ID()'
  'minIncreaseForExtension()'
  'expectedNftSupply()'
  'supplyMismatched()'
  'FINALIZE_GRACE()'
  'MAX_TOTAL_EXTENSION()'
  'requiredMintCapForSettlement()'
  'mintingUnavailable()'
)

make_multicall_data() {
  local target=$1
  local allow_failure=$2
  shift 2
  local signature call_data tuples=""
  for signature in "$@"; do
    call_data=$(cast calldata "$signature" 2>/dev/null) || die "could not encode ABI call: $signature"
    [[ "$call_data" =~ ^0x[0-9a-fA-F]+$ ]] || die "cast returned invalid calldata: $signature"
    tuples+="($target,$allow_failure,$call_data),"
  done
  tuples="[${tuples%,}]"
  cast calldata 'aggregate3((address,bool,bytes)[])' "$tuples" 2>/dev/null \
    || die "could not encode Multicall3 snapshot"
}

GLOBAL_DATA=$(make_multicall_data "$AUCTION" "$ALLOW_FAILURE" "${GLOBAL_SIGNATURES[@]}")

ACCOUNT_CALLS=(
  "$(cast calldata 'activeBidCount(address)' "$ACCOUNT" 2>/dev/null)"
  "$(cast calldata 'pendingReturns(address)' "$ACCOUNT" 2>/dev/null)"
  "$(cast calldata 'bidsOf(address)' "$ACCOUNT" 2>/dev/null)"
)
ACCOUNT_TUPLES=""
for account_call in "${ACCOUNT_CALLS[@]}"; do
  [[ "$account_call" =~ ^0x[0-9a-fA-F]+$ ]] || die "could not encode account snapshot"
  ACCOUNT_TUPLES+="($AUCTION,$ALLOW_FAILURE,$account_call),"
done
ACCOUNT_DATA=$(cast calldata 'aggregate3((address,bool,bytes)[])' "[${ACCOUNT_TUPLES%,}]" 2>/dev/null) \
  || die "could not encode account Multicall3 snapshot"

ENS_PAYLOADS=()
for ((ens_index = 1; ens_index <= 10#$ENS_RESOLUTIONS; ++ens_index)); do
  # Deterministic distinct addresses model up to 90 bidder rows without using real bidder data.
  printf -v ens_address '0x%040x' "$ens_index"
  ens_data=$(cast calldata 'reverseWithGateways(bytes,uint256,string[])' \
    "$ens_address" 60 '["x-batch-gateway:true"]' 2>/dev/null) \
    || die "could not encode ENS reverse lookup"
  [[ "${ens_data:0:10}" == "0xb7d6ca64" ]] \
    || die "ENS reverse lookup selector does not match installed viem ABI"
  ENS_PAYLOADS+=("$(printf '{"jsonrpc":"2.0","id":5,"method":"eth_call","params":[{"to":"%s","data":"%s"},"latest"]}' \
    "$ENS_RESOLVER_ADDRESS" "$ens_data")")
done

INCLUDE_LOGS=0
FROM_BLOCK=""
if [[ -n "$DEPLOY_BLOCK" ]]; then
  if [[ "$DEPLOY_BLOCK" =~ ^0x[0-9a-fA-F]+$ ]]; then
    FROM_BLOCK=$DEPLOY_BLOCK
  elif [[ "$DEPLOY_BLOCK" =~ ^[0-9]+$ ]]; then
    FROM_BLOCK=$(cast to-hex "$DEPLOY_BLOCK" 2>/dev/null) || die "RPC_LOAD_DEPLOY_BLOCK is too large or invalid"
  else
    die "RPC_LOAD_DEPLOY_BLOCK must be decimal or 0x-prefixed hexadecimal"
  fi
  INCLUDE_LOGS=1
  WON_TOPIC=$(cast keccak 'Won(uint32,address,uint256,uint96,uint96)' 2>/dev/null) \
    || die "could not encode Won event topic"
fi

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/panorama-rpc-load.XXXXXX")
trap 'rm -rf -- "$TEMP_DIR"' EXIT

BLOCK_PAYLOAD='{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}'
GLOBAL_PAYLOAD=$(printf '{"jsonrpc":"2.0","id":2,"method":"eth_call","params":[{"to":"%s","data":"%s"},"latest"]}' \
  "$MULTICALL_ADDRESS" "$GLOBAL_DATA")
ACCOUNT_PAYLOAD=$(printf '{"jsonrpc":"2.0","id":3,"method":"eth_call","params":[{"to":"%s","data":"%s"},"latest"]}' \
  "$MULTICALL_ADDRESS" "$ACCOUNT_DATA")
if ((INCLUDE_LOGS)); then
  LOG_PAYLOAD=$(printf '{"jsonrpc":"2.0","id":4,"method":"eth_getLogs","params":[{"address":"%s","fromBlock":"%s","toBlock":"latest","topics":["%s"]}]}' \
    "$AUCTION" "$FROM_BLOCK" "$WON_TOPIC")
fi

rpc_request() {
  local scenario=$1 label=$2 payload=$3 allow_expected_revert=${4:-0}
  local body="$TEMP_DIR/body.${scenario}.${label}" metrics curl_status http_code time_total latency_ms status

  if metrics=$(curl --silent --show-error \
      --connect-timeout "$CONNECT_TIMEOUT" --max-time "$REQUEST_TIMEOUT" \
      -H 'Content-Type: application/json' --data "$payload" \
      -o "$body" -w '%{http_code}\t%{time_total}' "$RPC_URL" 2>/dev/null); then
    curl_status=0
  else
    curl_status=$?
  fi

  IFS=$'\t' read -r http_code time_total <<<"${metrics:-000\t0}"
  [[ "$http_code" =~ ^[0-9]{3}$ ]] || http_code=000
  [[ "$time_total" =~ ^[0-9]+([.][0-9]+)?$ ]] || time_total=0
  latency_ms=$(awk -v seconds="$time_total" 'BEGIN { printf "%.0f", seconds * 1000 }')

  if ((curl_status != 0)); then
    if [[ "$http_code" == "429" ]]; then
      status=http_429
    else
      status=curl_error
    fi
  elif [[ "$http_code" == "429" ]]; then
    status=http_429
  elif ((10#$http_code < 200 || 10#$http_code >= 300)); then
    status=http_error
  elif grep -Eiq 'rate.?limit|too many requests|request limit|compute units|-32005' "$body"; then
    status=rpc_rate_limited
  elif grep -q '"error"[[:space:]]*:' "$body"; then
    if [[ "$allow_expected_revert" == "1" ]] \
        && grep -Eiq '0x(01800152|95c0c752|1e9535f2|77209fe8|ef9c03ce|7b1c461b)' "$body"; then
      # A valid ENS provider response for an address without a reverse record is commonly a
      # known Universal Resolver error. These are the exact error selectors that installed viem
      # maps to `null`; an arbitrary revert remains a failure so bad ABI/calldata cannot pass.
      status=ok_expected_revert
    else
      status=json_rpc_error
    fi
  elif [[ "$label" != "block" && "$label" != "logs" ]] \
      && grep -Eq '"result"[[:space:]]*:[[:space:]]*"0x"' "$body"; then
    # An empty eth_call result means the configured Multicall3 / ENS target has no compatible
    # code. Treat it as an invalid test environment, not a successful capacity sample.
    status=invalid_response
  elif ! grep -q '"result"[[:space:]]*:' "$body"; then
    status=invalid_response
  else
    status=ok
  fi

  printf '%s\t%s\t%s\t%s\t%s\n' "$scenario" "$label" "$status" "$latency_ms" "$http_code" \
    >> "$TEMP_DIR/result.$scenario"
  rm -f -- "$body"
}

run_scenario() {
  local scenario=$1 ens_running=0 ens_index ens_label
  : > "$TEMP_DIR/result.$scenario"
  rpc_request "$scenario" block "$BLOCK_PAYLOAD"
  rpc_request "$scenario" global "$GLOBAL_PAYLOAD"
  rpc_request "$scenario" account "$ACCOUNT_PAYLOAD"
  for ((ens_index = 1; ens_index <= 10#$ENS_RESOLUTIONS; ++ens_index)); do
    printf -v ens_label 'ens%03d' "$ens_index"
    rpc_request "$scenario" "$ens_label" "${ENS_PAYLOADS[$((ens_index - 1))]}" 1 &
    ens_running=$((ens_running + 1))
    if ((ens_running >= 10#$ENS_CONCURRENCY)); then
      wait -n || true
      ens_running=$((ens_running - 1))
    fi
  done
  wait || true
  if ((INCLUDE_LOGS)); then
    rpc_request "$scenario" logs "$LOG_PAYLOAD"
  fi
}

printf 'Panorama auction RPC load test (read-only)\n'
if [[ "$SYNTHETIC" == "1" ]]; then
  printf 'MODE: SYNTHETIC — allowFailure=true against a placeholder target; capacity signal only\n'
else
  printf 'MODE: DEPLOYED AUCTION — allowFailure=false, matching production contract reads\n'
fi
printf 'Snapshots: %s; concurrency: %s; HTTP reads per snapshot: %s\n' \
  "$REQUESTS" "$CONCURRENCY" "$((3 + 10#$ENS_RESOLUTIONS + INCLUDE_LOGS))"
printf 'Global snapshot: %s contract reads via Multicall3; account snapshot: 3 reads\n' \
  "${#GLOBAL_SIGNATURES[@]}"
printf 'ENS reverse lookups per snapshot: %s (up to %s concurrent per client)\n' \
  "$ENS_RESOLUTIONS" "$ENS_CONCURRENCY"
if ((INCLUDE_LOGS)); then
  printf 'Settlement log scan: enabled from configured deployment block\n'
else
  printf 'Settlement log scan: disabled (set RPC_LOAD_DEPLOY_BLOCK to include it)\n'
fi

running=0
for ((scenario = 1; scenario <= 10#$REQUESTS; ++scenario)); do
  run_scenario "$scenario" &
  running=$((running + 1))
  if ((running >= 10#$CONCURRENCY)); then
    wait -n || true
    running=$((running - 1))
  fi
done
wait || true

RESULTS="$TEMP_DIR/results.tsv"
: > "$RESULTS"
for ((scenario = 1; scenario <= 10#$REQUESTS; ++scenario)); do
  [[ -f "$TEMP_DIR/result.$scenario" ]] || die "a load-test worker did not produce a result"
  cat "$TEMP_DIR/result.$scenario" >> "$RESULTS"
done

TOTAL=$(wc -l < "$RESULTS" | awk '{print $1}')
OK=$(awk -F '\t' '$3 ~ /^ok/ { count++ } END { print count + 0 }' "$RESULTS")
FAILED=$((TOTAL - OK))
RATE_LIMITED=$(awk -F '\t' '$3 == "http_429" || $3 == "rpc_rate_limited" { count++ } END { print count + 0 }' "$RESULTS")
EXPECTED_REVERTS=$(awk -F '\t' '$3 == "ok_expected_revert" { count++ } END { print count + 0 }' "$RESULTS")

printf '\nHTTP request results\n'
printf '  total: %s\n  successful: %s\n  failed: %s\n  rate-limited: %s\n' \
  "$TOTAL" "$OK" "$FAILED" "$RATE_LIMITED"
if ((EXPECTED_REVERTS > 0)); then
  printf '  expected ENS null/revert responses: %s\n' "$EXPECTED_REVERTS"
fi

for category in curl_error http_429 http_error rpc_rate_limited json_rpc_error invalid_response; do
  count=$(awk -F '\t' -v category="$category" '$3 == category { count++ } END { print count + 0 }' "$RESULTS")
  if ((count > 0)); then
    printf '  %-18s %s\n' "$category:" "$count"
  fi
done

if ((OK > 0)); then
  LATENCIES="$TEMP_DIR/latencies"
  awk -F '\t' '$3 ~ /^ok/ { print $4 }' "$RESULTS" | sort -n > "$LATENCIES"
  mapfile -t latency_values < "$LATENCIES"
  latency_count=${#latency_values[@]}
  p50_index=$(((latency_count * 50 + 99) / 100 - 1))
  p95_index=$(((latency_count * 95 + 99) / 100 - 1))
  p99_index=$(((latency_count * 99 + 99) / 100 - 1))
  average=$(awk '{ total += $1 } END { if (NR) printf "%.0f", total / NR; else print 0 }' "$LATENCIES")
  printf '\nSuccessful-request latency (ms)\n'
  printf '  avg: %s  p50: %s  p95: %s  p99: %s  max: %s\n' \
    "$average" "${latency_values[$p50_index]}" "${latency_values[$p95_index]}" \
    "${latency_values[$p99_index]}" "${latency_values[$((latency_count - 1))]}"
fi

latency_summary() {
  local name=$1
  local label_pattern=$2
  local values_file="$TEMP_DIR/latencies.$name"
  local count p50_index p95_index p99_index average
  local -a category_values=()
  awk -F '\t' -v pattern="$label_pattern" \
    '$3 ~ /^ok/ && $2 ~ pattern { print $4 }' "$RESULTS" | sort -n > "$values_file"
  mapfile -t category_values < "$values_file"
  count=${#category_values[@]}
  ((count > 0)) || return 0
  p50_index=$(((count * 50 + 99) / 100 - 1))
  p95_index=$(((count * 95 + 99) / 100 - 1))
  p99_index=$(((count * 99 + 99) / 100 - 1))
  average=$(awk '{ total += $1 } END { if (NR) printf "%.0f", total / NR; else print 0 }' "$values_file")
  printf '  %-8s n=%-5s avg=%-5s p50=%-5s p95=%-5s p99=%-5s max=%s\n' \
    "$name" "$count" "$average" "${category_values[$p50_index]}" \
    "${category_values[$p95_index]}" "${category_values[$p99_index]}" \
    "${category_values[$((count - 1))]}"
}

if ((OK > 0)); then
  printf '\nLatency by request class (ms)\n'
  latency_summary block '^block$'
  latency_summary global '^global$'
  latency_summary account '^account$'
  latency_summary ens '^ens[0-9]+$'
  latency_summary logs '^logs$'
fi

printf '\nEndpoint value was intentionally not printed. No write RPC methods were used.\n'
((FAILED == 0)) || exit 1

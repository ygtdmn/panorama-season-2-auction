#!/usr/bin/env bash
# Local, network-free regression tests for monitor-auction.sh and rpc-load-test.sh.
set -euo pipefail
LC_ALL=C
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MONITOR="$SCRIPT_DIR/monitor-auction.sh"
LOAD_TEST="$SCRIPT_DIR/rpc-load-test.sh"
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/panorama-operations-test.XXXXXX")
cleanup() {
  if [[ "${KEEP_TEST_TMP:-0}" == "1" ]]; then
    printf 'test artifacts kept at %s\n' "$TEMP_DIR" >&2
  else
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local file=$1 expected=$2
  grep -Fq -- "$expected" "$file" || fail "$file did not contain: $expected"
}

assert_not_contains() {
  local file=$1 unexpected=$2
  if grep -Fq -- "$unexpected" "$file"; then
    fail "$file unexpectedly contained: $unexpected"
  fi
}

bash -n "$MONITOR" "$LOAD_TEST"

MONITOR_MOCK_BIN="$TEMP_DIR/monitor-bin"
mkdir -m 700 "$MONITOR_MOCK_BIN"

cat > "$MONITOR_MOCK_BIN/cast" <<'MOCK_CAST'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  call)
    case "${3:-}" in
      'phase()(uint8)') printf '%s\n' "${MOCK_PHASE:-0}" ;;
      'paused()(bool)') printf '%s\n' "${MOCK_PAUSED:-false}" ;;
      'endTime()(uint64)') printf '%s\n' "${MOCK_END:-2000000000}" ;;
      'activeBids()(uint256)') printf '%s\n' "${MOCK_BIDS:-5}" ;;
      'currentClearingPrice()(uint256)') printf '%s\n' "${MOCK_FLOOR:-100000000000000000}" ;;
      'supplyMismatched()(bool)') printf '%s\n' "${MOCK_MISMATCH:-false}" ;;
      'mintingUnavailable()(bool)') printf '%s\n' "${MOCK_MINTING_UNAVAILABLE:-false}" ;;
      'totalLiabilities()(uint256)') printf '%s\n' "${MOCK_LIAB:-100000000000000000}" ;;
      *) exit 64 ;;
    esac
    ;;
  balance)
    printf '%s\n' "${MOCK_BAL:-100000000000000000}"
    ;;
  from-wei)
    printf '0.1\n'
    ;;
  *)
    exit 64
    ;;
esac
MOCK_CAST

cat > "$MONITOR_MOCK_BIN/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${MOCK_CURL_LOG:-}" ]]; then
  printf 'called\n' >> "$MOCK_CURL_LOG"
fi
printf '%s' "${MOCK_CURL_HTTP:-204}"
exit "${MOCK_CURL_EXIT:-0}"
MOCK_CURL
chmod 700 "$MONITOR_MOCK_BIN/cast" "$MONITOR_MOCK_BIN/curl"

AUCTION=0x1111111111111111111111111111111111111111
RPC_WITH_SECRET=https://rpc.example.invalid/SECRET_SENTINEL
STATE_FILE="$TEMP_DIR/monitor.state"

run_monitor() {
  env PATH="$MONITOR_MOCK_BIN:$PATH" HOME="$TEMP_DIR" RPC_URL="$RPC_WITH_SECRET" \
    AUCTION="$AUCTION" STATE_FILE="$STATE_FILE" "$MONITOR" "$@"
}

run_monitor --healthcheck > "$TEMP_DIR/health.out" 2> "$TEMP_DIR/health.err"
assert_contains "$TEMP_DIR/health.out" "healthcheck OK"
[[ ! -e "$STATE_FILE" ]] || fail "healthcheck changed monitor state"
assert_not_contains "$TEMP_DIR/health.out" SECRET_SENTINEL
assert_not_contains "$TEMP_DIR/health.err" SECRET_SENTINEL

run_monitor > "$TEMP_DIR/initial.out" 2> "$TEMP_DIR/initial.err"
assert_contains "$STATE_FILE" "PREV_PHASE=0"
[[ "$(stat -c '%a' "$STATE_FILE")" == "600" ]] || fail "monitor state is not mode 0600"

MOCK_CURL_LOG="$TEMP_DIR/webhook.calls"
if env MOCK_PHASE=1 MOCK_CURL_EXIT=22 MOCK_CURL_HTTP=500 MOCK_CURL_LOG="$MOCK_CURL_LOG" \
    DISCORD_WEBHOOK_URL=https://discord.example.invalid/SECRET_WEBHOOK \
    PATH="$MONITOR_MOCK_BIN:$PATH" HOME="$TEMP_DIR" RPC_URL="$RPC_WITH_SECRET" \
    AUCTION="$AUCTION" STATE_FILE="$STATE_FILE" "$MONITOR" \
    > "$TEMP_DIR/webhook-fail.out" 2> "$TEMP_DIR/webhook-fail.err"; then
  fail "monitor succeeded despite webhook failure"
fi
assert_contains "$TEMP_DIR/webhook-fail.err" "webhook delivery failed"
assert_contains "$TEMP_DIR/webhook-fail.err" "state was not advanced"
assert_contains "$STATE_FILE" "PREV_PHASE=0"
assert_not_contains "$TEMP_DIR/webhook-fail.err" SECRET_WEBHOOK
assert_not_contains "$TEMP_DIR/webhook-fail.err" SECRET_SENTINEL

env MOCK_PHASE=1 MOCK_CURL_LOG="$MOCK_CURL_LOG" \
  DISCORD_WEBHOOK_URL=https://discord.example.invalid/SECRET_WEBHOOK \
  PATH="$MONITOR_MOCK_BIN:$PATH" HOME="$TEMP_DIR" RPC_URL="$RPC_WITH_SECRET" \
  AUCTION="$AUCTION" STATE_FILE="$STATE_FILE" "$MONITOR" \
  > "$TEMP_DIR/webhook-ok.out" 2> "$TEMP_DIR/webhook-ok.err"
assert_contains "$STATE_FILE" "PREV_PHASE=1"
assert_contains "$MOCK_CURL_LOG" "called"

BIG_STATE="$TEMP_DIR/big.state"
env MOCK_BAL=999999999999999999999999999999999999999999999999999 \
  MOCK_LIAB=1000000000000000000000000000000000000000000000000000 \
  PATH="$MONITOR_MOCK_BIN:$PATH" HOME="$TEMP_DIR" RPC_URL="$RPC_WITH_SECRET" \
  AUCTION="$AUCTION" STATE_FILE="$BIG_STATE" "$MONITOR" \
  > "$TEMP_DIR/big.out" 2> "$TEMP_DIR/big.err"
assert_contains "$TEMP_DIR/big.out" "CRITICAL: balance"

MINTING_STATE="$TEMP_DIR/minting.state"
env MOCK_END=1 MOCK_MINTING_UNAVAILABLE=true \
  PATH="$MONITOR_MOCK_BIN:$PATH" HOME="$TEMP_DIR" RPC_URL="$RPC_WITH_SECRET" \
  AUCTION="$AUCTION" STATE_FILE="$MINTING_STATE" "$MONITOR" \
  > "$TEMP_DIR/minting.out" 2> "$TEMP_DIR/minting.err"
assert_contains "$TEMP_DIR/minting.out" "auction ended but minting is unavailable"

MALICIOUS_STATE="$TEMP_DIR/malicious.state"
MARKER="$TEMP_DIR/state-was-executed"
printf 'PREV_PHASE=$(touch %s)\n' "$MARKER" > "$MALICIOUS_STATE"
chmod 600 "$MALICIOUS_STATE"
if env PATH="$MONITOR_MOCK_BIN:$PATH" HOME="$TEMP_DIR" RPC_URL="$RPC_WITH_SECRET" \
    AUCTION="$AUCTION" STATE_FILE="$MALICIOUS_STATE" "$MONITOR" \
    > "$TEMP_DIR/malicious.out" 2> "$TEMP_DIR/malicious.err"; then
  fail "monitor accepted executable state content"
fi
assert_contains "$TEMP_DIR/malicious.err" "STATE_FILE contains an invalid PREV_PHASE"
[[ ! -e "$MARKER" ]] || fail "monitor executed state-file content"

LOAD_MOCK_BIN="$TEMP_DIR/load-bin"
mkdir -m 700 "$LOAD_MOCK_BIN"
cat > "$LOAD_MOCK_BIN/curl" <<'LOAD_CURL'
#!/usr/bin/env bash
set -euo pipefail
output=""
while (($#)); do
  if [[ "$1" == "-o" ]]; then
    output=$2
    shift 2
  else
    shift
  fi
done
[[ -n "$output" ]] || exit 65
if [[ "${LOAD_CURL_MODE:-ok}" == "rate" ]]; then
  printf '{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limit"}}' > "$output"
  printf '429\t0.010'
  exit 22
fi
printf '{"jsonrpc":"2.0","id":1,"result":"0x1"}' > "$output"
printf '200\t0.012'
LOAD_CURL
chmod 700 "$LOAD_MOCK_BIN/curl"

env PATH="$LOAD_MOCK_BIN:$PATH" RPC_URL="$RPC_WITH_SECRET" AUCTION="$AUCTION" \
  RPC_LOAD_REQUESTS=3 RPC_LOAD_CONCURRENCY=2 \
  RPC_LOAD_ENS_RESOLUTIONS=2 RPC_LOAD_ENS_CONCURRENCY=2 "$LOAD_TEST" \
  > "$TEMP_DIR/load-ok.out" 2> "$TEMP_DIR/load-ok.err"
assert_contains "$TEMP_DIR/load-ok.out" "Global snapshot: 40 contract reads"
assert_contains "$TEMP_DIR/load-ok.out" "ENS reverse lookups per snapshot: 2"
assert_contains "$TEMP_DIR/load-ok.out" "total: 15"
assert_contains "$TEMP_DIR/load-ok.out" "successful: 15"
assert_contains "$TEMP_DIR/load-ok.out" "p95: 12"
assert_not_contains "$TEMP_DIR/load-ok.out" SECRET_SENTINEL
assert_not_contains "$TEMP_DIR/load-ok.err" SECRET_SENTINEL

if env LOAD_CURL_MODE=rate PATH="$LOAD_MOCK_BIN:$PATH" RPC_URL="$RPC_WITH_SECRET" AUCTION="$AUCTION" \
    RPC_LOAD_REQUESTS=2 RPC_LOAD_CONCURRENCY=1 \
    RPC_LOAD_ENS_RESOLUTIONS=2 RPC_LOAD_ENS_CONCURRENCY=2 "$LOAD_TEST" \
    > "$TEMP_DIR/load-rate.out" 2> "$TEMP_DIR/load-rate.err"; then
  fail "load test succeeded despite rate limiting"
fi
assert_contains "$TEMP_DIR/load-rate.out" "rate-limited: 10"
assert_not_contains "$TEMP_DIR/load-rate.out" SECRET_SENTINEL
assert_not_contains "$TEMP_DIR/load-rate.err" SECRET_SENTINEL

env PATH="$LOAD_MOCK_BIN:$PATH" RPC_URL="$RPC_WITH_SECRET" RPC_LOAD_SYNTHETIC=1 \
  RPC_LOAD_ENS_RESOLUTIONS=0 "$LOAD_TEST" \
  > "$TEMP_DIR/load-synthetic.out" 2> "$TEMP_DIR/load-synthetic.err"
assert_contains "$TEMP_DIR/load-synthetic.out" "MODE: SYNTHETIC"
assert_contains "$TEMP_DIR/load-synthetic.out" "total: 3"
assert_contains "$TEMP_DIR/load-synthetic.out" "successful: 3"
assert_not_contains "$TEMP_DIR/load-synthetic.out" SECRET_SENTINEL
assert_not_contains "$TEMP_DIR/load-synthetic.err" SECRET_SENTINEL

printf 'operations script tests: PASS\n'

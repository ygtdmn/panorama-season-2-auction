#!/usr/bin/env bash
# Emits a deployment manifest for the Season 2 auction as JSON on stdout.
# Captures everything needed to re-verify the deployment later: addresses, codehash,
# every immutable, live NFT/controller state, git commit, and chain context.
#
# Usage:
#   RPC_URL=https://... PANORAMA_AUCTION_ADDRESS=0x... scripts/auction-manifest.sh \
#     > deployments/auction-$(date -u +%Y%m%d).json
#
# Requires: cast (foundry), git, jq (optional; output is valid JSON without it).
set -euo pipefail

: "${RPC_URL:?RPC_URL is required}"
: "${PANORAMA_AUCTION_ADDRESS:?PANORAMA_AUCTION_ADDRESS is required}"

A="$PANORAMA_AUCTION_ADDRESS"
call() { cast call "$A" "$1" --rpc-url "$RPC_URL" | awk '{print $1}'; }

NFT=$(call 'nft()(address)')
CONTROLLER=$(cast call "$NFT" 'mintController()(address)' --rpc-url "$RPC_URL" | awk '{print $1}')

cat <<EOF
{
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "chainId": $(cast chain-id --rpc-url "$RPC_URL"),
  "block": $(cast block-number --rpc-url "$RPC_URL"),
  "gitCommit": "$(git rev-parse HEAD 2>/dev/null || echo unknown)",
  "gitDirty": $(test -z "$(git status --porcelain 2>/dev/null)" && echo false || echo true),
  "auction": {
    "address": "$A",
    "runtimeCodehash": "$(cast codehash "$A" --rpc-url "$RPC_URL")",
    "owner": "$(call 'owner()(address)')",
    "nft": "$NFT",
    "payoutA": "$(call 'payoutA()(address)')",
    "payoutB": "$(call 'payoutB()(address)')",
    "reservePriceWei": "$(call 'reservePrice()(uint96)')",
    "minIncrementBps": $(call 'minIncrementBps()(uint16)'),
    "startTime": $(call 'startTime()(uint64)'),
    "endTime": $(call 'endTime()(uint64)'),
    "absoluteEndTime": $(call 'absoluteEndTime()(uint64)'),
    "phase": $(call 'phase()(uint8)'),
    "paused": $(call 'paused()(bool)'),
    "firstTokenId": $(call 'FIRST_TOKEN_ID()(uint256)'),
    "maxUnits": $(call 'MAX_UNITS()(uint256)')
  },
  "nft": {
    "address": "$NFT",
    "owner": "$(cast call "$NFT" 'owner()(address)' --rpc-url "$RPC_URL" | awk '{print $1}')",
    "totalMinted": $(cast call "$NFT" 'totalMinted()(uint256)' --rpc-url "$RPC_URL" | awk '{print $1}'),
    "mintCap": $(cast call "$NFT" 'mintCap()(uint256)' --rpc-url "$RPC_URL" | awk '{print $1}'),
    "auctionAuthorized": $(cast call "$NFT" 'authorizedOperators(address)(bool)' "$A" --rpc-url "$RPC_URL")
  },
  "mintController": {
    "address": "$CONTROLLER",
    "owner": "$(cast call "$CONTROLLER" 'owner()(address)' --rpc-url "$RPC_URL" | awk '{print $1}')",
    "seasonCount": $(cast call "$CONTROLLER" 'seasonCount()(uint8)' --rpc-url "$RPC_URL" | awk '{print $1}'),
    "season1Cap": $(cast call "$CONTROLLER" 'seasonMintCap(uint8)(uint256)' 1 --rpc-url "$RPC_URL" | awk '{print $1}'),
    "season2Cap": $(cast call "$CONTROLLER" 'seasonMintCap(uint8)(uint256)' 2 --rpc-url "$RPC_URL" | awk '{print $1}')
  }
}
EOF

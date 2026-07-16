# Contracts

Foundry project for `PanoramaSeason2Auction` and everything needed to test and operate it.

## Layout

```
src/
  PanoramaSeason2Auction.sol   The auction (the subject of this repo)
  Panorama.sol                 The live ERC-721 the auction mints from (Solady ERC721)
  PanoramaMintController.sol   Season mint caps + operator authorization
  interfaces/                  IPanorama, IPanoramaMintController, IPanoramaRenderer
test/
  PanoramaSeason2Auction.t.sol                    101 unit + fuzz tests
  PanoramaSeason2Auction.invariants.t.sol         8 invariant campaigns (heap property,
                                                  heapPos bijection, exact solvency,
                                                  no-overmint, per-wallet cap)
  PanoramaSeason2AuctionAtomicSettlement.t.sol    4 atomic-settlement script tests
script/
  Base.s.sol                   Broadcaster base; requires explicit PRIVATE_KEY, no fallback
  DeployAuction.s.sol          Validated deploy (config bounds, live NFT state checks)
  SettleAuctionAtomic.s.sol    authorize -> exact cap -> finalize batches -> revoke,
                               as one EOA run or one Safe Transaction Builder batch
  DeployAuctionSepolia.s.sol   Sepolia rehearsal deploy (same validation, testnet chain gate)
  CancelAuction.s.sol          Owner cancel while Active
  RefundAllAuction.s.sol       Permissionless batched refunds after cancel
scripts/
  auction-manifest.sh          JSON deployment manifest (addresses, codehash, immutables)
  monitor-auction.sh           Cron monitor with Discord alerts
  rpc-load-test.sh             Progressive RPC capacity testing
  test-operations.sh           Network-free regression tests for the two scripts above
deployments/
  auction-20260716.json        Mainnet deployment manifest
AUCTION_RUNBOOK.md             Deploy/settle/incident procedures
```

## Mainnet deployment

| | |
|---|---|
| Auction | [`0x902237C2B0A4B428eefEd862019D5FF0a6E509fd`](https://etherscan.io/address/0x902237C2B0A4B428eefEd862019D5FF0a6E509fd) (source-verified) |
| Deployed | 2026-07-16 |
| Runtime codehash | `0x9c6a9b7aa81314c29cbe93f0d8c3f841c4db09d6b7e15dae8f260c0f14a59cfe` |
| Schedule | Opens 2026-07-22 17:00 UTC, 24h duration, absolute end 2026-07-24 17:00 UTC |
| Manifest | [deployments/auction-20260716.json](deployments/auction-20260716.json) |

## Build and test

Requires [Foundry](https://getfoundry.sh) and [Bun](https://bun.sh) (dependencies install to `node_modules`, see `remappings.txt`).

```bash
bun install
forge build
forge test                                # all 113 tests
FOUNDRY_PROFILE=ci forge test \
  --match-path 'test/PanoramaSeason2Auction*' -vv   # CI profile: 10k fuzz runs,
                                                    # 512 invariant campaigns x 128 calls
forge fmt --check
scripts/test-operations.sh                # ops script regression tests, no network
```

## Deploy and operate

Read [AUCTION_RUNBOOK.md](AUCTION_RUNBOOK.md) first. Short version:

```bash
export PRIVATE_KEY=...
export PANORAMA_NFT=0x435BD9CF72C278c9bAD9655732a6724469c6D9Ff
export PANORAMA_AUCTION_RESERVE_PRICE=...    # wei, >= 0.1 ETH (contract floor)
export PANORAMA_AUCTION_MIN_INCREMENT_BPS=500
export PANORAMA_AUCTION_START=...            # unix, strictly future
export PANORAMA_AUCTION_DURATION=86400       # 1h..30d
export PANORAMA_PAYOUT_A=... PANORAMA_PAYOUT_B=...
forge script script/DeployAuction.s.sol:DeployAuction --rpc-url mainnet --broadcast --verify
```

All lifecycle scripts refuse to run on any chain but mainnet, and every post-deploy script additionally pins `PANORAMA_AUCTION_RUNTIME_CODEHASH` (obtain it independently with `cast codehash`). RPC endpoints in `foundry.toml` read `API_KEY_ALCHEMY`; Etherscan verification reads `API_KEY_ETHERSCAN`.

## Key parameters

| Constant | Value |
|---|---|
| `MAX_UNITS` | 90 (tokens #91-#180) |
| `MIN_RESERVE_PRICE` | 0.1 ETH |
| `MAX_BIDS_PER_WALLET` | 4 |
| `EXT_WINDOW` / `EXT_LEN` | 5 min / 10 min (anti-snipe) |
| `MAX_TOTAL_EXTENSION` | 24 h past scheduled end |
| `FINALIZE_GRACE` | 7 days (then finalize is permissionless) |
| `EMERGENCY_GRACE` | 30 days past `absoluteEndTime` |
| `SPLIT_A_BPS` | 5800 (58/42 proceeds split, immutable recipients) |

Gas: `finalize(45)` is roughly 8.1M; keep batches at 45 or below since hostile refund receivers can add up to ~100k gas per winner.

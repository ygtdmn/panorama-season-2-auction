# Panorama Season 2 Auction

The smart contract, tests, operations tooling, and web frontend for the [Panorama](https://panorama.garden) Season 2 sale: a multi-unit English auction with a uniform clearing price, selling tokens #91-#180 of the Panorama ERC-721 collection on Ethereum mainnet.

Panorama is an autonomous generative art system that paints one segment of a continuously expanding panorama every day, driven by on-chain price data. Season 2 covers days 91 through 180. This repository sells those 90 tokens in a single auction.

## Mainnet deployment

`PanoramaSeason2Auction` is live and source-verified at [`0x902237C2B0A4B428eefEd862019D5FF0a6E509fd`](https://etherscan.io/address/0x902237C2B0A4B428eefEd862019D5FF0a6E509fd). Bidding opens 2026-07-21 17:00 UTC and runs 24 hours, with at most 24 further hours of anti-snipe extension. Reserve 0.1 ETH, minimum increment 5%.

The deployment manifest, recording every immutable, the runtime codehash, and the NFT and mint controller state at deploy time, is committed at [contracts/deployments/auction-20260716.json](contracts/deployments/auction-20260716.json). Anyone can regenerate it against the chain with `contracts/scripts/auction-manifest.sh` and diff.

## How the auction works

- **Bid the maximum you are willing to pay.** The top 90 bids win. Every winner pays the same price: the 90th-highest bid (the clearing price). The excess over the clearing price is refunded at settlement.
- **Reserve.** No bid below 0.1 ETH is ever accepted. The contract hard-codes this floor (`MIN_RESERVE_PRICE`); the constructor rejects any lower configuration.
- **Once 90 bids are in**, a new bid must beat the current lowest winning bid by `minIncrementBps` (ceiling math, so the advertised percentage is never rounded down). The displaced bidder is refunded in the same transaction.
- **Up to 4 bids per wallet.** Each bid is independent and can win its own token. `increaseBid` tops up an existing bid.
- **Anti-snipe.** A qualifying bid inside the final 5 minutes extends the auction by 10 minutes. Total extension is capped at 24 hours past the scheduled end (`absoluteEndTime`), so the auction always has a hard deadline.
- **Ties** go to the earlier bid. Equal amounts never displace an older bid.
- **Settlement.** `finalize` runs in batches: it freezes the clearing price, mints winners highest-bid-first (top bid receives #91, the earliest daily reveal slot), refunds the excess, and on the last batch splits proceeds 58/42 between two fixed payout addresses. A refund that reverts is ledgered for pull-based `withdraw`; a hostile receiver cannot block settlement.

### Trust model

The owner can never take escrowed funds. Every ETH path out of the contract either mints a token to a winner at the clearing price or refunds a bidder. If the owner disappears or misbehaves, permissionless recovery takes over:

| Situation | Who can act | Function |
|---|---|---|
| Owner never settles | Anyone, 7 days after end | `finalize` |
| Owner cancels | Anyone | `refundAll` (batched, full refunds) |
| An external mint consumes an expected token id | Anyone, immediately | `recoverFromSupplyMismatch` |
| Mint authorization or capacity missing after end | Anyone, 7 days after end | `recoverFromMintingUnavailable` |
| Everything else fails | Anyone, 30 days after `absoluteEndTime` | `emergencyRefund` |
| A refund transfer failed and was ledgered | The bidder | `withdraw` |

The frontend ships a public [/recovery](frontend/src/app/recovery) page that drives each of these paths, with an Etherscan `#writeContract` fallback documented for every one.

## Repository layout

```
contracts/   Foundry project: the auction contract, the Panorama NFT + mint
             controller it mints from, 113 tests (unit, fuzz, invariant,
             atomic-settlement), lifecycle forge scripts, and shell tooling
             for monitoring and deployment manifests.
frontend/    Standalone Next.js app: public bidding page (/auction),
             wallet-gated owner console (/admin), and public recovery
             tools (/recovery). Vitest unit tests + anvil-backed
             Playwright e2e.
```

Each package has its own README with build and test instructions:

- [contracts/README.md](contracts/README.md)
- [frontend/README.md](frontend/README.md)

## Quick start

Contracts (needs [Foundry](https://getfoundry.sh) and [Bun](https://bun.sh)):

```bash
cd contracts
bun install
forge test
```

Frontend (needs Node 22 and [pnpm](https://pnpm.io)):

```bash
cd frontend
pnpm install
pnpm dev        # http://localhost:5470/auction?demo=1 for a live in-memory simulation
```

Demo mode (`?demo=1`) runs the full bidding experience against an in-memory model that mirrors the Solidity logic bid for bid, so you can explore the UI without a deployed contract or a wallet. The URL param works in dev and on non-mainnet builds; mainnet production builds ignore it. A production-platform build fails outright if `NEXT_PUBLIC_AUCTION_DEMO=1` is set, so a dedicated demo deployment must live on a preview (non-production) environment.

## Contract design notes

`contracts/src/PanoramaSeason2Auction.sol` (Solidity 0.8.34, [Solady](https://github.com/Vectorized/solady) `Ownable` + `ReentrancyGuardTransient`):

- The active bid set lives in a 1-based indexed binary **min-heap** (`_heap` + `heapPos` bijection). The root is always the clearing floor, so displacement checks are O(1) and insert/replace are O(log 90).
- Only the top 90 bids escrow ETH. A displaced bidder is refunded with `forceSafeTransferETH`, so a contract that rejects ETH cannot grief the order book.
- Bidding **fails closed**: if `nft.totalMinted() != 90` at any point, `placeBid` reverts. Every `finalize` batch re-checks supply, authorization, and cap, and requires each minted id to equal `91 + finalizeCursor`. A single stray mint from outside stops settlement atomically and immediately enables permissionless refunds.
- Inside the anti-snipe window, a bid increase below the increment threshold reverts instead of silently not extending, so a competitive raise cannot be split across calls to dodge the extension rule.
- Phase machine: `Active -> Finalizing -> Settled`, or `Active -> Cancelled`. Terminal states are mutually exclusive, and all recovery paths share one idempotent completion routine.
- Owner extras are deliberately narrow: `setSchedule` (only until the first bid), `setPaused` (gates bids only; the clock keeps running), and liability-aware `rescueSurplusETH` that works only in terminal states and can never touch escrow.
- Runtime bytecode is 21,063 bytes, 3.5 KB under the EIP-170 limit.

The test suite (113 tests) includes fuzzed bidding, invariant campaigns that hold heap integrity, `heapPos` bijection, exact solvency through settlement, no-overmint, and the per-wallet cap while a handler drives finalize, emergency, cancel, and competing external mints. See [contracts/test/](contracts/test/).

## Operations

- [contracts/AUCTION_RUNBOOK.md](contracts/AUCTION_RUNBOOK.md): deploy checklist, settlement procedure (single atomic Safe batch or EOA sequence), incident playbooks, monitoring setup, RPC load testing, and fork rehearsal.
- `contracts/script/SettleAuctionAtomic.s.sol`: authorize, cap to the exact winner count, finalize in batches, revoke, all in one closed sequence. With `--sig 'safeBatch()'` it prints a Safe Transaction Builder JSON so the entire settlement is one atomic Safe transaction.
- `contracts/scripts/monitor-auction.sh`: cron monitor that posts Discord alerts on phase changes, pauses, anti-snipe extensions, supply mismatches, and balance-vs-liability drift.
- `contracts/scripts/auction-manifest.sh`: emits a JSON deployment manifest (addresses, codehash, every immutable, chain context) for later re-verification.

Every lifecycle script is mainnet-gated, validates full-width environment values before narrowing, pins the deployed runtime codehash via `PANORAMA_AUCTION_RUNTIME_CODEHASH`, and requires an explicit `PRIVATE_KEY` with no fallback.

## Provenance

Extracted from the Panorama monorepo so the full sale mechanism is publicly reviewable. The Panorama collection contract (ERC-721) lives at [`0x435BD9CF72C278c9bAD9655732a6724469c6D9Ff`](https://etherscan.io/address/0x435BD9CF72C278c9bAD9655732a6724469c6D9Ff) on mainnet; copies of `Panorama.sol` and `PanoramaMintController.sol` are included here because the tests and the e2e chain deploy the real stack the auction mints against.

## License

[MIT](LICENSE.md)

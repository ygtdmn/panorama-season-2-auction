# Season 2 Auction — Operations Runbook

Operational procedures for deploying, running, settling, and recovering the
`PanoramaSeason2Auction` sale (tokens #91–#180). Commands assume `contracts/` as cwd.
The contract source of truth is `src/PanoramaSeason2Auction.sol`.

Every forge script here requires an explicit `PRIVATE_KEY` (there is no fallback key) and
refuses to run on any chain but mainnet. Rehearse the full flow on a fork first (see §7).

---

## 1. Roles and keys

| Key | Controls | Used by |
|---|---|---|
| NFT + controller owner | `setAuthorizedOperator`, `setSeasonMintCap` | SettleAuctionAtomic |
| Auction owner (deployer) | `finalize` before grace, `cancelAuction`, `setPaused`, `setSchedule`, rescues | DeployAuction, CancelAuction, admin UI |
| Anyone | `refundAll` (after cancel), `emergencyRefund` (after grace), `recoverFromSupplyMismatch` (on mismatch), `recoverFromMintingUnavailable` (after 7-day grace), `finalize` (after 7-day grace), `withdraw` | /recovery page, Etherscan |

Recommended: move NFT, controller, and auction ownership to a Safe before the sale and
execute settlement as a single Safe batch (§5, `safeBatch`). If staying on an EOA, use a
hardware wallet and never reuse the key for anything else during the sale window.

## 2. Pre-deploy checklist

1. **Commit and tag.** The deployed source must be a committed tree; record the tag in the
   manifest. `git status` must be clean for `contracts/` and `frontend/`.
2. **Tests green.** This revision discovers **113 auction tests** (including invariants and
   atomic-settlement script tests), **56 frontend unit tests**, and **15 browser scenarios**.
   The command output is authoritative if those counts change:
   ```bash
   FOUNDRY_PROFILE=ci forge test --match-path 'test/PanoramaSeason2Auction*' -vv
   cd ../frontend
   pnpm install --frozen-lockfile
   pnpm run ci
   pnpm run build
   pnpm run test:e2e
   pnpm run audit:prod
   ```
   (`pnpm audit --prod` no longer works: npm retired the quick-audit endpoint it calls, HTTP
   410 since mid-2026. `audit:prod` runs `scripts/audit-prod.mjs`, which audits the exact
   installed production closure against npm's replacement bulk advisory endpoint — the same
   step CI runs.)
3. **RPC capacity.** Verify the Alchemy (or equivalent) account is not rate-capped and has
   headroom for auction-week traffic. The frontend needs `NEXT_PUBLIC_RPC_URL` set to an
   authenticated endpoint; the deploy scripts need `foundry.toml`'s `mainnet` RPC working.
4. **Operator audit.** Reconstruct the full authorization history and confirm no stray
   operator is authorized:
   ```bash
   cast logs --rpc-url $RPC --from-block 24941545 --to-block latest \
     --address 0x435BD9CF72C278c9bAD9655732a6724469c6D9Ff \
     0x2b354ade00599743d1a975e67ff021962f1ea8b421f7683ebf5435303263c02f
   ```
   (topic0 = `AuthorizedOperatorUpdated(address,bool)`; NFT deploy block is 24,941,545.)
   As of 2026-07-11 the only entry ever authorized, `0x5fa1...891e`, was revoked at block
   25,017,987. Expected live state: `totalMinted == 90`, `mintCap == 90`.
5. **Baseline reads.**
   ```bash
   cast call $NFT 'totalMinted()(uint256)' --rpc-url $RPC     # 90
   cast call $NFT 'mintCap()(uint256)' --rpc-url $RPC          # 90
   cast call $NFT 'owner()(address)' --rpc-url $RPC
   cast call $NFT 'mintController()(address)' --rpc-url $RPC
   ```
6. **Frontend env** (frontend/.env or platform): `NEXT_PUBLIC_CHAIN_ID=1`,
   `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`,
   `NEXT_PUBLIC_PANORAMA_AUCTION_ADDRESS` (after deploy),
   `NEXT_PUBLIC_AUCTION_DEPLOY_BLOCK` (after deploy), and `PANORAMA_PRODUCTION=1` so the
   build-time env assertions arm. A production build without RPC or WalletConnect id fails
   by design.
7. **Monitoring.** Install the monitor dependencies, run `scripts/test-operations.sh`, configure
   its private state path and Discord webhook, and pass the RPC + webhook healthcheck in §6
   before bidding opens. Alert on a nonzero cron/systemd exit; a failed RPC read or webhook
   delivery is a monitoring failure.

## 3. Deploy

```bash
export PRIVATE_KEY=...                       # auction deployer/owner
export PANORAMA_NFT=0x435BD9CF72C278c9bAD9655732a6724469c6D9Ff
export PANORAMA_AUCTION_RESERVE_PRICE=...    # wei, >= 0.1 ETH (contract floor MIN_RESERVE_PRICE)
export PANORAMA_AUCTION_MIN_INCREMENT_BPS=500
export PANORAMA_AUCTION_START=...            # unix, strictly future; leave hours of margin
export PANORAMA_AUCTION_DURATION=86400       # 1h..30d
export PANORAMA_PAYOUT_A=...                 # 58%
export PANORAMA_PAYOUT_B=...                 # 42%
forge script script/DeployAuction.s.sol:DeployAuction --rpc-url mainnet --broadcast --verify
```

The script validates the full config, requires `totalMinted == 90` and `mintCap == 90`,
and prints the **runtime code hash**. Then:

1. Record the manifest (requires `RPC_URL` and `PANORAMA_AUCTION_ADDRESS`; run from a clean
   tree so `gitDirty` records false):
   ```bash
   RPC_URL=... PANORAMA_AUCTION_ADDRESS=... \
     scripts/auction-manifest.sh > deployments/auction-$(date -u +%Y%m%d).json
   ```
   and commit it. If the script fails, delete the empty file the redirect left behind.
2. Verify the source on Etherscan (the `--verify` flag, or `forge verify-contract`).
3. Obtain the codehash independently (`cast codehash $AUCTION --rpc-url $RPC`) and compare
   with the deploy output; this value gates every later script.
4. Set the frontend env (address + deploy block) and redeploy the site; confirm the
   countdown, reserve, and increment render from chain data.
5. Between deployment and `startTime`: nothing else to do. Bidding opens by itself. The
   schedule can still be adjusted with `setSchedule` until the first bid.

## 4. During the auction

- **No collection mutations.** Do not call `setSeasonMintCap`, `setAuthorizedOperator`, or
  any mint. The cap equals `totalMinted`, so mints revert anyway; the discipline is about
  not disturbing the baseline the auction fail-closes against.
- **Pause policy.** `setPaused(true)` stops bids but the clock keeps running.
  Treat pause as an emergency brake for a frontend exploit or an RPC incident, disclose it
  publicly the moment it happens, and either unpause with real time left or cancel.
- **Cancel policy.** `cancelAuction()` is owner-discretion while Active and it
  is visible to bidders that the owner holds it. Policy for this sale: cancel only for a
  security incident or a fundamentally broken sale, never in reaction to price discovery.
- Monitoring alerts on: phase change, pause flips, supply mismatch, extension bursts, and
  any balance-vs-liability drift (§6).

## 5. Settlement (after `endTime`)

Preferred: **one closed sequence** with zero gaps between authorization, cap, minting, and
revocation.

```bash
export PRIVATE_KEY=...                        # must own NFT + controller (+ auction, before grace)
export PANORAMA_NFT=... PANORAMA_MINT_CONTROLLER=... PANORAMA_AUCTION_ADDRESS=...
export PANORAMA_AUCTION_RUNTIME_CODEHASH=...  # from §3 step 3, independently obtained
export PANORAMA_AUCTION_OWNER=...
export PANORAMA_AUCTION_RESERVE_PRICE=... PANORAMA_AUCTION_MIN_INCREMENT_BPS=500
export PANORAMA_AUCTION_START=... PANORAMA_AUCTION_DURATION=86400
export PANORAMA_PAYOUT_A=... PANORAMA_PAYOUT_B=...
export PANORAMA_FINALIZE_BATCH=45

# EOA: broadcast authorize -> exact cap -> finalize... -> revoke back-to-back in one run
forge script script/SettleAuctionAtomic.s.sol:SettleAuctionAtomic --rpc-url mainnet --broadcast

# Safe: print a Transaction Builder JSON so the whole sequence is ONE atomic transaction
forge script script/SettleAuctionAtomic.s.sol:SettleAuctionAtomic --sig 'safeBatch()' --rpc-url mainnet
```

Notes:
- The cap is opened by the **exact winner count**, so even the owner cannot mint a stray
  token mid-settlement, and after completion `mintCap == totalMinted` again.
- Gas: `finalize(45)` ≈ 8.1M; a full 90-winner Safe batch ≈ 16.4M in one transaction.
  Hostile refund receivers can add up to ~100k gas per winner; keep batches ≤ 45.
- The atomic script is the only settle path; the old split scripts (authorize, then
  finalize later) were removed because a gap between the two steps is exactly the mint
  window this sequence exists to close. If the script is ever unusable, the wallet-gated
  `/admin` console (or `/recovery` after the 7-day grace) drives the contract's `finalize`
  directly; grant `setAuthorizedOperator` + the exact-winner mint cap immediately before,
  and revoke immediately after, in the same sitting.
- Post-checks (the script asserts them; verify independently): phase Settled, escrow and
  unreleased proceeds zero, `totalMinted == 90 + winners`, operator revoked, payout
  addresses received the 58/42 split.
- Check for `RefundFailed` events afterwards; affected bidders withdraw via `/recovery`
  (funds are ledgered, nothing to do operationally).

## 6. Incidents

| Scenario | Action |
|---|---|
| Must stop the sale (exploit, broken frontend) | `setPaused(true)`, disclose, fix, unpause or cancel |
| Sale must be voided while Active | `CancelAuction.s.sol`, then anyone: `RefundAllAuction.s.sol` (or /recovery) |
| A stray mint consumed a token id | Nothing to decide: bidding/settlement fail closed; anyone can `recoverFromSupplyMismatch` (also on /recovery) |
| Minting unavailable (authorization missing/revoked or cap insufficient) | Fix rights/cap during the normal settlement window. At `endTime + 7d`, anyone can call `recoverFromMintingUnavailable` to refund every unminted bid; already-minted winner proceeds release when recovery completes. |
| Owner keys lost after end | At `endTime + 7d`, anyone can `finalize` when minting is available, or `recoverFromMintingUnavailable` when it is not. `emergencyRefund` remains the catch-all after the hard grace. |
| ETH sent to the contract by mistake | After terminal state: `rescueSurplusETH` (only provable surplus; escrow is untouchable) |

### Monitoring and RPC health

The monitor requires Bash 4+, Foundry `cast`, `curl`, `timeout`, `flock`, and GNU coreutils. It
does **not** require `bc` or `jq`. By default, state is stored under
`$XDG_STATE_HOME/panorama-auction/` or `$HOME/.local/state/panorama-auction/`, in a mode-0700
directory. If `STATE_FILE` is overridden, its directory must be owned by the monitor user and
must not be group/world writable. State is strictly parsed as data and replaced atomically; it
is never sourced as shell code.

Before installing the cron entry, test RPC reads and actual webhook delivery:

```bash
scripts/test-operations.sh

RPC_URL=... AUCTION=0x... DISCORD_WEBHOOK_URL=... \
  scripts/monitor-auction.sh --healthcheck
```

The command must exit zero and the healthcheck message must arrive in Discord. Webhook calls
have bounded connect/total timeouts. HTTP failures are written to stderr, return a nonzero
monitor exit, and leave the previous state unchanged so transition alerts retry on the next run.

Then run `scripts/monitor-auction.sh` from cron (e.g. every minute during the sale):

```bash
RPC_URL=... AUCTION=0x... DISCORD_WEBHOOK_URL=... \
  STATE_FILE=/var/lib/panorama-auction/monitor.state \
  scripts/monitor-auction.sh
```

It keeps a state file and posts to Discord on phase changes, pauses, extensions, supply
mismatch, and liability/balance drift. Route nonzero cron exits/stderr to a separate operator
alarm so a broken RPC or webhook cannot silently disable monitoring.

Capacity-test the exact authenticated production endpoint progressively. Before an auction is
deployed, synthetic mode sends the same 40-call and three-call Multicall3 payload shapes with
`allowFailure=true` against a non-contract placeholder. Synthetic results measure provider
transport/Multicall/ENS capacity only; they do not validate deployed auction behavior.

The script defaults to **90 independent ENS reverse resolutions per client** as a worst-case
upper-bound stress test. The frontend itself resolves only rows entering the viewport (plus a
240px margin) and caches names for 24 hours, so roughly 12 concurrent lookups is the normal
launch-page shape; a rapid full-board scroll can eventually request all 90 over time.
`RPC_LOAD_ENS_RESOLUTIONS=0` remains useful for isolating contract-read latency.

Start with one client and only increase after a clean result:

```bash
# Pre-deployment: one upper-bound synthetic client (40 global + 3 account + 90 ENS reads).
RPC_URL=... RPC_LOAD_SYNTHETIC=1 \
  RPC_LOAD_REQUESTS=1 RPC_LOAD_CONCURRENCY=1 \
  scripts/rpc-load-test.sh

# Then a small concurrent burst.
RPC_URL=... RPC_LOAD_SYNTHETIC=1 \
  RPC_LOAD_REQUESTS=5 RPC_LOAD_CONCURRENCY=2 \
  scripts/rpc-load-test.sh

# Only after both are clean, exercise the bounded launch burst.
RPC_URL=... RPC_LOAD_SYNTHETIC=1 \
  RPC_LOAD_REQUESTS=20 RPC_LOAD_CONCURRENCY=4 \
  RPC_LOAD_ENS_RESOLUTIONS=12 RPC_LOAD_ENS_CONCURRENCY=12 \
  scripts/rpc-load-test.sh

# Separately stress the full 90-name upper bound; this is intentionally harsher than first paint.
RPC_URL=... RPC_LOAD_SYNTHETIC=1 \
  RPC_LOAD_REQUESTS=20 RPC_LOAD_CONCURRENCY=4 \
  RPC_LOAD_ENS_RESOLUTIONS=90 RPC_LOAD_ENS_CONCURRENCY=10 \
  scripts/rpc-load-test.sh
```

After deployment, repeat the progression with real fail-closed contract reads, then include the
settlement standings scan:

```bash
RPC_URL=... AUCTION=0x... RPC_LOAD_REQUESTS=1 RPC_LOAD_CONCURRENCY=1 \
  scripts/rpc-load-test.sh

RPC_URL=... AUCTION=0x... RPC_LOAD_REQUESTS=5 RPC_LOAD_CONCURRENCY=2 \
  scripts/rpc-load-test.sh

RPC_URL=... AUCTION=0x... RPC_LOAD_DEPLOY_BLOCK=... \
  RPC_LOAD_REQUESTS=20 RPC_LOAD_CONCURRENCY=4 \
  scripts/rpc-load-test.sh
```

Record successful-request average/p50/p95/p99/max latency and require zero transport, HTTP,
JSON-RPC, invalid-response, and rate-limit failures at every stage. Compare latency as concurrency
rises; stop if p95/p99 climbs sharply even before explicit 429s. The tool caps snapshots at 200,
client concurrency at 32, ENS lookups at 90 per client, and per-client ENS concurrency at 30.
Increase confidence through repeated bounded runs, not by removing those safety limits.

### 2026-07-11 authenticated-RPC result (endpoint redacted)

Pre-deployment synthetic tests exercised the real authenticated mainnet provider and live
Multicall3/ENS Universal Resolver without persisting or printing its credential:

| Shape | Result | Aggregate latency | Critical request classes |
|---|---|---|---|
| 1 client, 90 ENS | 93/93, no rate limits | p95 221ms, p99 265ms | clean |
| 5 clients / 2 concurrent, 90 ENS each | 465/465, no rate limits | p95 274ms, p99 635ms | clean |
| 20 clients / 4 concurrent, 90 ENS each (repeat) | 1,856/1,860; 4 ENS-side curl failures, no rate limits | p95 1,039ms, p99 2,782ms | global multicall p95 337ms; account multicall p95 258ms; all 20 requests in each class succeeded |
| 20 clients / 4 concurrent, 12 visible ENS each | 300/300, no rate limits | p95 638ms, p99 669ms | global multicall p95 205ms; account multicall p95 181ms; ENS p95 651ms |

Verdict: the critical block/global/account reads passed the tested launch burst. The original
all-90-at-once ENS shape was not reliable enough on repeat, which is why the frontend now lazy
loads and caches names. Repeat the deployed-auction mode, including `RPC_LOAD_DEPLOY_BLOCK`, once
the final address exists; synthetic mode does not validate the deployed ABI or event-log range.

## 7. Fork rehearsal

Full dry-run against real mainnet state (both scripts were verified this way):

```bash
anvil --fork-url $RPC --chain-id 1 --port 9545 &
# move NFT + controller ownership to the test key on the fork
cast rpc anvil_impersonateAccount $OWNER --rpc-url http://127.0.0.1:9545
cast send $NFT  'transferOwnership(address)' $TEST --from $OWNER --unlocked --rpc-url http://127.0.0.1:9545
cast send $CTRL 'transferOwnership(address)' $TEST --from $OWNER --unlocked --rpc-url http://127.0.0.1:9545
# then: DeployAuction -> place bids with cast -> warp past end -> SettleAuctionAtomic
```

Also rehearse the cancel path and an `emergencyRefund` at least once before launch.

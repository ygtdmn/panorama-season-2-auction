# Frontend

Standalone Next.js 16 app for the Season 2 auction. Three routes:

- **`/auction`**: public bidding page (`/` redirects here). Live standings, bid form with quick-fills, an intro article with an 11-question FAQ, and post-settlement results reconstructed from `Won` event logs.
- **`/admin`**: owner console, gated on the connected wallet matching `owner()`. Batched finalize, cancel, refundAll, pause. Noindexed. The wallet check is client-side convenience only; the security boundary is the contract's `onlyOwner` modifiers, which revert any write from a non-owner regardless of what the page renders.
- **`/recovery`**: public self-serve settlement and refund tools: `withdraw`, permissionless `finalize` after the 7-day grace, cancelled-auction refunds, supply-mismatch recovery, and `emergencyRefund`, each with live availability, a countdown to eligibility, and an Etherscan `#writeContract` fallback.

Stack: React 19, TypeScript, Tailwind CSS 4, wagmi 3 + viem 2, TanStack Query.

## Develop

```bash
pnpm install
pnpm dev        # port 5470
```

Open [http://localhost:5470/auction?demo=1](http://localhost:5470/auction?demo=1) to run without a deployed contract. The `?demo=1` URL param works in dev and on non-mainnet builds only; mainnet production builds ignore it, so a shared link can never show the simulation as the real auction (set `NEXT_PUBLIC_AUCTION_DEMO=1` for a dedicated demo deployment). Demo mode (`src/lib/demoStore.ts`) mirrors the Solidity logic exactly: ceiling basis-point math, the 24h extension cap, in-window sub-threshold raise rejection, id tie-breaks, and time-gated emergency refunds. Unit tests assert this parity against shared fixtures.

Against a real chain, copy `.env.example` to `.env` and fill in the values. `src/lib/env.ts` validates the configuration at build time; a production mainnet build (`VERCEL_ENV=production` or `PANORAMA_PRODUCTION=1`) fails without an authenticated `NEXT_PUBLIC_RPC_URL` and a WalletConnect project id, by design.

## Design decisions

- **No device clock.** Live/ended state derives from the latest block timestamp plus elapsed time (`useChainNow`), so a skewed local clock cannot show a closed auction as open.
- **Fail closed.** Contract reads use `allowFailure: false` with no zero-value defaults. A failed multicall renders an error surface, and stale data disables actions instead of guessing.
- **Simulate before signing.** Every write runs `simulateContract` first, so a doomed transaction surfaces a decoded custom error (all 30 of them) before the wallet opens.
- **One formatter.** `src/lib/format.ts` owns all number handling: exact values in inputs, ceiling display for minimums (type what you see, it never reverts), and comma/dot normalization that can never silently change magnitude.

## Test

```bash
pnpm test       # vitest: 40 unit tests (formatting, error decoding, env validation,
                # Won-log integrity, demo/Solidity parity)
pnpm lint
pnpm typecheck
```

End-to-end (needs Foundry; run `forge build` in `../contracts` first so the artifacts exist):

```bash
pnpm test:e2e   # Playwright boots anvil on 8546, deploys the real Panorama NFT,
                # mint controller, and auction from the forge artifacts, injects an
                # EIP-6963 wallet shim, and drives 15 scenarios: bidding, displacement,
                # front-run revert recovery, anti-snipe extension, wallet rejection,
                # tx replacement, batched admin settlement, cancel + refunds,
                # permissionless finalize via /recovery, and mobile layout.
```

Tests snapshot and revert anvil state between scenarios, so they run serially and deterministically.

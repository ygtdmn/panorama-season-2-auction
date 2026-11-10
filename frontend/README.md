# Frontend

Standalone Next.js 16 App Router app for the Season 2 auction, built with [vinext](https://github.com/cloudflare/vinext) (Vite) and served as the Cloudflare Worker `panorama-season-2-auction`. Three routes:

- **`/`**: public bidding page (the old `/auction` path redirects here). Live standings, bid form with quick-fills, an intro article with a 12-question FAQ (including the audit report), and post-settlement results reconstructed from `Won` event logs.
- **`/admin`**: owner console, gated on the connected wallet matching `owner()`. Batched finalize, cancel, refundAll, pause. Noindexed. The wallet check is client-side convenience only; the security boundary is the contract's `onlyOwner` modifiers, which revert any write from a non-owner regardless of what the page renders.
- **`/recovery`**: public self-serve settlement and refund tools: `withdraw`, permissionless `finalize` after the 7-day grace, cancelled-auction refunds, supply-mismatch recovery, and `emergencyRefund`, each with live availability, a countdown to eligibility, and an Etherscan `#writeContract` fallback.

Stack: React 19, TypeScript, Tailwind CSS 4, wagmi 3 + viem 2, TanStack Query.

## Develop

```bash
pnpm install
pnpm dev        # vinext dev server on port 5470
pnpm build      # vinext build (Worker output in .cloudflare/output)
pnpm start      # run the built Worker locally in workerd (vite preview)
```

Open [http://localhost:5470/?demo=1](http://localhost:5470/?demo=1) to run without a deployed contract. The `?demo=1` URL param works in dev and on non-mainnet builds only; mainnet production builds ignore it, so a shared link can never show the simulation as the real auction. A production-platform build fails outright if `NEXT_PUBLIC_AUCTION_DEMO=1` is set; run dedicated demo deployments on a preview (non-production) environment. Demo mode (`src/lib/demoStore.ts`) mirrors the Solidity logic exactly: ceiling basis-point math, the 24h extension cap, in-window sub-threshold raise rejection, id tie-breaks, and time-gated emergency refunds. Unit tests assert this parity against shared fixtures.

Against a real chain, copy `.env.example` to `.env` and fill in the values. `src/lib/env.ts` validates the configuration at build time (it runs from `next.config.ts`, which vinext loads); a production mainnet build (`PANORAMA_PRODUCTION=1`) fails without a `NEXT_PUBLIC_RPC_URL` and a WalletConnect project id, by design.

## Deploy

```bash
pnpm run deploy # PANORAMA_PRODUCTION=1 build + deploy to Cloudflare (needs `npx cf auth login`)
```

`cloudflare.config.ts` declares the Worker (workers.dev only for now: `domains: []`, `workersDev: true`, `previewUrls: false`; no KV, no Images binding, no secrets). The production build values are the committed `.env.production`; `scripts/deploy.mjs` copies them into the build's environment so a local `.env.local` cannot override them, and sets `PANORAMA_PRODUCTION=1` so the strict checks run.

## Design decisions

- **No device clock.** Live/ended state derives from the latest block timestamp plus elapsed time (`useChainNow`), so a skewed local clock cannot show a closed auction as open.
- **Fail closed.** Contract reads use `allowFailure: false` with no zero-value defaults. A failed multicall renders an error surface, and stale data disables actions instead of guessing.
- **Simulate before signing.** Every write runs `simulateContract` first, so a doomed transaction surfaces a decoded custom error (all 30 of them) before the wallet opens.
- **One formatter.** `src/lib/format.ts` owns all number handling: exact values in inputs, ceiling display for minimums (type what you see, it never reverts), and comma/dot normalization that can never silently change magnitude.

## Test

```bash
pnpm test       # vitest: 64 unit tests (formatting, error decoding, env validation,
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

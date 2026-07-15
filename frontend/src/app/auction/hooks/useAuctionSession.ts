"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";
import { useAuctionState, type AuctionState } from "./useAuctionState";
import { useAuctionActions, type AuctionActions } from "./useAuctionActions";
import {
  bpsIncrement,
  demoStore,
  DEMO_EMERGENCY_GRACE,
  DEMO_FINALIZE_GRACE,
  DEMO_IDENTITIES,
  DEMO_INC_BPS,
  DEMO_MAX_BIDS_PER_WALLET,
  DEMO_MAX_UNITS,
  DEMO_PAYOUT_A,
  DEMO_PAYOUT_B,
  DEMO_RESERVE,
  type DemoScenario,
  type DemoSnapshot,
} from "../demo/demoStore";

const PHASES = ["active", "finalizing", "settled", "cancelled"] as const;

export interface DemoControls {
  you: string;
  identities: string[];
  won: number;
  log: string[];
  switchIdentity: () => void;
  seedBid: () => void;
  fillToCapacity: () => void;
  endNow: () => void;
  setUpcoming: () => void;
  jumpTo: (scenario: DemoScenario) => void;
  reset: () => void;
}

export interface AuctionSession {
  demo: boolean;
  isConnected: boolean;
  address?: string;
  state: AuctionState;
  actions: AuctionActions;
  controls: DemoControls | null;
}

const noopSubscribe = () => () => {};
function readUrlDemo(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("demo") === "1";
  } catch {
    return false;
  }
}

/**
 * Demo is on when NEXT_PUBLIC_AUCTION_DEMO=1, or when the URL has ?demo=1 in
 * dev or on a non-mainnet build. Mainnet production builds ignore the URL param:
 * a shared ?demo=1 link must never swap the real auction for the simulation.
 */
export function useIsDemo(): boolean {
  const envDemo = process.env.NEXT_PUBLIC_AUCTION_DEMO === "1";
  // Unset chain id defaults to mainnet, mirroring src/lib/env.ts.
  const urlDemoAllowed =
    process.env.NODE_ENV !== "production" ||
    (process.env.NEXT_PUBLIC_CHAIN_ID ?? "1") !== "1";
  // useSyncExternalStore reads the client URL without a hydration mismatch:
  // server snapshot is false, client snapshot reflects the real query string.
  const urlDemo = useSyncExternalStore(noopSubscribe, readUrlDemo, () => false);
  return envDemo || (urlDemoAllowed && urlDemo);
}

function deriveState(s: DemoSnapshot): AuctionState {
  const full = s.bids.length >= DEMO_MAX_UNITS;
  const low = s.bids.length
    ? s.bids.reduce(
        (lo, b) =>
          b.amount < lo.amount || (b.amount === lo.amount && b.id > lo.id)
            ? b
            : lo,
        s.bids[0],
      )
    : null;
  const floor = low ? low.amount : 0n;
  const minBid = !full ? DEMO_RESERVE : floor + bpsIncrement(floor);
  const yourBids = s.bids
    .filter((b) => b.bidder === s.you)
    .map((b) => ({ id: b.id, amount: b.amount }));
  const allBids = [...s.bids]
    .sort((x, y) =>
      x.amount < y.amount ? 1 : x.amount > y.amount ? -1 : x.id - y.id,
    )
    .map((b) => ({
      id: b.id,
      bidder: b.bidder as `0x${string}`,
      amount: b.amount,
    }));
  const wonBids = s.won.map((w) => ({
    id: w.id,
    bidder: w.bidder as `0x${string}`,
    amount: w.amount,
    tokenId: w.tokenId,
    pricePaid: w.pricePaid,
  }));
  const nowSec = Math.floor(Date.now() / 1000);

  return {
    ready: true,
    isLoading: false,
		readFailed: false,
		degraded: false,
		stale: false,
		accountReady: true,
		accountReadFailed: false,
		refetch: () => {},
    chainTime: { timestamp: nowSec, atMs: Date.now() },
    phase: PHASES[s.phase],
    paused: s.paused,
    startTime: s.startTime,
    endTime: s.endTime,
    absoluteEndTime: s.absoluteEndTime,
    scheduledEndTime: s.scheduledEndTime,
    reservePrice: DEMO_RESERVE,
    minIncrementBps: DEMO_INC_BPS,
    extensionCount: s.extensionCount,
    maxUnits: DEMO_MAX_UNITS,
    maxBidsPerWallet: DEMO_MAX_BIDS_PER_WALLET,
    activeBids: s.bids.length,
    isFull: full,
    currentClearingPrice: full ? floor : DEMO_RESERVE,
    lowestActiveBid: low ? floor : 0n,
    minimumBid: minBid,
    minIncreaseForExtension: floor > 0n ? bpsIncrement(floor) : 0n,
    clearingPrice: s.clearingPrice,
    proceeds: s.proceeds,
    finalizeCursor: s.finalizeCursor,
    refundCursor: 0,
    winnerCount: s.winnerCount,
    refundsComplete: s.refundsComplete,
    totalEscrowed: s.bids.reduce((sum, bid) => sum + bid.amount, 0n),
    totalPendingReturns: Object.values(s.pending).reduce(
      (sum, amount) => sum + amount,
      0n,
    ),
    unreleasedProceeds: s.phase === 1 ? s.proceeds : 0n,
    totalLiabilities:
      s.bids.reduce((sum, bid) => sum + bid.amount, 0n) +
      Object.values(s.pending).reduce((sum, amount) => sum + amount, 0n) +
      (s.phase === 1 ? s.proceeds : 0n),
    surplusEth: 0n,
    finalizeEligibleAt: s.endTime > 0 ? s.endTime + DEMO_FINALIZE_GRACE : 0,
    emergencyEligibleAt:
      s.absoluteEndTime > 0 ? s.absoluteEndTime + DEMO_EMERGENCY_GRACE : 0,
		expectedNftSupply: 90 + s.finalizeCursor,
		supplyMismatched: false,
		requiredMintCapForSettlement:
			s.phase === 0
				? 90n + BigInt(s.bids.length)
				: s.phase === 1
					? 90n + BigInt(s.winnerCount)
					: 0n,
		mintingUnavailable: false,
    firstTokenId: 91,
    lastTokenId: 180,
    owner: s.you as `0x${string}`,
    payoutA: DEMO_PAYOUT_A as `0x${string}`,
    payoutB: DEMO_PAYOUT_B as `0x${string}`,
		allBids,
		wonBids,
		wonStatus: "ready",
		wonExpectedCount: s.finalizeCursor,
		wonIntegrityIssue: undefined,
		refetchWon: () => {},
    isOwner: true,
    yourBidCount: yourBids.length,
    yourBids,
    yourPending: s.pending[s.you] ?? 0n,
  };
}

function deriveActions(s: DemoSnapshot): AuctionActions {
  return {
		status: s.actionStatus,
		lastAction: undefined,
		txHash: undefined,
		originalTxHash: undefined,
		replacementHash: undefined,
		replacementReason: undefined,
		error: s.actionError ? new Error(s.actionError) : null,
		unresolved: false,
		trackerReady: true,
    wrongChain: false,
    switching: false,
    switchToTargetChain: () => {},
    reset: () => demoStore.setStatus("idle"),
    placeBid: (v) => demoStore.placeBid(s.you, v),
    increaseBid: (id, add) => demoStore.increaseBid(s.you, id, add),
    withdraw: () => demoStore.withdraw(s.you),
    finalize: (b) => demoStore.finalize(b),
    cancelAuction: () => demoStore.cancel(),
    refundAll: (b) => demoStore.refundAll(b),
    emergencyRefund: (b) => demoStore.emergencyRefund(b),
		recoverFromSupplyMismatch: () => demoStore.recoverSupplyMismatch(),
		recoverFromMintingUnavailable: () => demoStore.setStatus("error", "Minting is still available."),
    setPaused: (p) => demoStore.setPaused(p),
  };
}

function useAuctionDemo(active: boolean) {
  const snap = useSyncExternalStore(
    demoStore.subscribe,
    demoStore.getSnapshot,
    demoStore.getServerSnapshot,
  );
  useEffect(() => {
    if (active) demoStore.start();
  }, [active]);

  const state = useMemo(() => deriveState(snap), [snap]);
  const actions = useMemo(() => deriveActions(snap), [snap]);
  const controls = useMemo<DemoControls>(
    () => ({
      you: snap.you,
      identities: DEMO_IDENTITIES,
      won: snap.won.filter((w) => w.bidder === snap.you).length,
      log: snap.log,
      switchIdentity: () => {
        const i = DEMO_IDENTITIES.indexOf(snap.you);
        demoStore.setYou(DEMO_IDENTITIES[(i + 1) % DEMO_IDENTITIES.length]);
      },
      seedBid: () => demoStore.seedBid(),
      fillToCapacity: () => demoStore.fillToCapacity(),
      endNow: () => demoStore.endNow(),
      setUpcoming: () => demoStore.setUpcoming(),
      jumpTo: (scenario) => demoStore.jumpTo(scenario),
      reset: () => demoStore.reset(),
    }),
    [snap],
  );

  return { state, actions, controls, you: snap.you };
}

/**
 * Single entry point for the auction pages. Always calls the same hooks (stable
 * order) and returns either the live-contract bundle or the in-memory demo one.
 */
export function useAuctionSession(pollMs?: number): AuctionSession {
  const demo = useIsDemo();
  const realState = useAuctionState(pollMs);
  const realActions = useAuctionActions(() => realState.refetch());
  const { address, isConnected } = useAccount();
  const demoBundle = useAuctionDemo(demo);

  if (demo) {
    return {
      demo: true,
      isConnected: true,
      address: demoBundle.you,
      state: demoBundle.state,
      actions: demoBundle.actions,
      controls: demoBundle.controls,
    };
  }
  return {
    demo: false,
    isConnected,
    address,
    state: realState,
    actions: realActions,
    controls: null,
  };
}

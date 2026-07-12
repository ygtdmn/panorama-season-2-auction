"use client";

import { useEffect, useState } from "react";
import Header from "@/app/components/Header";
import { WalletPill } from "@/app/components/WalletPill";
import { useToast } from "@/app/components/Toast";
import {
  getBlockExplorerTxUrl,
  PANORAMA_AUCTION_ADDRESS,
} from "@/lib/constants";
import { describeAuctionError } from "@/lib/auctionErrors";
import { useAuctionSession } from "@/app/auction/hooks/useAuctionSession";
import { DemoBar } from "@/app/auction/components/DemoBar";
import {
  displayPhase,
  eth,
  Label,
  LiveDot,
  useChainNow,
} from "@/app/auction/components/ui";
import { parseBoundedIntegerInput } from "@/lib/format";
import {
  pendingActionLabel,
  TransactionStatus,
} from "@/app/components/TransactionStatus";

/** Keep a single finalize transaction comfortably under the block gas limit.
 *  finalize(45) measures ~8.1M gas; hostile refund receivers can add up to ~100k per winner. */
const MAX_BATCH = 60;

const PRIMARY =
  "font-mono text-xs uppercase tracking-[0.2em] bg-foreground text-background px-6 py-3.5 transition-all duration-200 hover:opacity-90 active:translate-y-px disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer";
const GHOST =
  "font-mono text-xs uppercase tracking-[0.2em] border border-line px-5 py-3.5 text-foreground transition-colors duration-200 hover:border-foreground active:translate-y-px disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer";
const DANGER =
  "font-mono text-xs uppercase tracking-[0.2em] border border-signal/50 text-signal px-5 py-3.5 transition-colors duration-200 hover:border-signal hover:bg-signal/[0.06] active:translate-y-px disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer";
const PANEL = "border border-line bg-surface p-6 md:p-7";

function Cell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 py-3">
      <Label>{label}</Label>
      <span className="font-serif text-lg tabular-nums text-foreground leading-none">
        {children}
      </span>
    </div>
  );
}

export default function AuctionAdminPage() {
  const toast = useToast();
  const {
    demo,
    isConnected,
    state: s,
    actions,
    controls,
  } = useAuctionSession(6_000);
  const now = useChainNow(s.chainTime);
  const [batch, setBatch] = useState("45");
  const [lastTx, setLastTx] = useState<`0x${string}`>();

  useEffect(() => {
    if (actions.txHash) setLastTx(actions.txHash);
  }, [actions.txHash]);

  useEffect(() => {
    if (actions.status === "error" && actions.error) {
      const msg = describeAuctionError(actions.error);
      if (msg) toast.error(msg);
      actions.reset();
    }
    if (actions.status === "success") {
      toast.success("Transaction confirmed.");
      actions.reset();
    }
	if (actions.status === "cancelled") {
	  toast.info("Transaction cancelled in your wallet. No auction action was submitted.");
	  actions.reset();
	}
	if (actions.status === "replaced") {
	  toast.info("A different replacement transaction confirmed. No auction action was submitted.");
	  actions.reset();
	}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.status]);

	const busy = actions.unresolved;
	const unsafeSnapshot = s.degraded || s.stale;
	const writeBlocked = busy || unsafeSnapshot;
	const parsedBatch = parseBoundedIntegerInput(batch, 1, MAX_BATCH);
	const batchValid = parsedBatch !== null;
	const batchN = parsedBatch ?? 0;
  const ended = now !== 0 && now >= s.endTime;
  const emergencyAvailable =
    now !== 0 &&
    now > s.emergencyEligibleAt &&
    (s.phase === "active" || s.phase === "finalizing");
	const mintingRecoveryAvailable =
	  !s.supplyMismatched &&
	  s.mintingUnavailable &&
	  now !== 0 &&
	  now >= s.finalizeEligibleAt &&
	  (s.phase === "active" || s.phase === "finalizing");

  const shell = (body: React.ReactNode) => (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Header />
      <div className="h-20 shrink-0" />
      <main className="mx-auto w-full max-w-[840px] xl:max-w-[1000px] 3xl:max-w-[1200px] 4xl:max-w-[1440px] px-5 md:px-10 3xl:px-16 4xl:px-24 pb-32 animate-modal-in">
        <div className="flex items-center justify-between gap-4 pt-4 md:pt-8 mb-8">
          <div className="flex items-center gap-3">
            <LiveDot phase={displayPhase(s.phase, now, s.startTime, s.endTime)} />
            <h1 className="font-serif text-2xl tracking-tight">
              Auction console
            </h1>
          </div>
          {!demo && <WalletPill />}
        </div>
        {demo && controls && <DemoBar controls={controls} />}
        {body}
      </main>
    </div>
  );

  if (!PANORAMA_AUCTION_ADDRESS && !demo)
    return shell(
      <p className="font-sans text-sm text-muted">
        Auction is not configured.
      </p>,
    );
	if (!demo && !s.ready && !s.readFailed)
	  return shell(
		<div className="flex flex-col gap-2 py-8" role="status">
		  <Label>Loading</Label>
		  <p className="font-sans text-sm text-muted">Reading auction and owner state…</p>
		</div>,
	  );
	if (!demo && s.readFailed)
	  return shell(
		<div className="flex flex-col items-start gap-3 py-8" role="alert">
		  <Label className="text-signal">Connection problem</Label>
		  <p className="font-sans text-sm text-muted">
			Auction state could not be verified. Owner actions remain locked.
		  </p>
		  <button className={GHOST} onClick={() => s.refetch()}>retry now</button>
		</div>,
	  );
  if (!isConnected)
    return shell(
      <div className="flex items-center gap-4">
        <p className="font-sans text-sm text-muted">
          Connect the owner wallet to manage the auction.
        </p>
        <WalletPill connectLabel="connect" />
      </div>,
    );
  if (!s.isOwner)
    return shell(
      <p className="font-sans text-sm text-signal">
        This wallet is not the auction owner. Owner actions are unavailable.
      </p>,
    );

  return shell(
    <div className="flex flex-col gap-4">
	  {unsafeSnapshot && (
		<div className="border border-signal/50 px-4 py-3 flex items-center justify-between gap-4" role="alert">
		  <p className="font-sans text-sm text-muted">
			Auction reads are stale or degraded. Every owner write is locked until refresh succeeds.
		  </p>
		  <button className={GHOST} onClick={() => s.refetch()}>retry</button>
		</div>
	  )}
	  <TransactionStatus actions={actions} />
      {/* State */}
      <section className={PANEL}>
        <div className="grid grid-cols-2 sm:grid-cols-4 3xl:grid-cols-8 gap-x-4 sm:gap-x-8">
          <Cell label="Phase">{s.phase}</Cell>
          <Cell label="Active bids">
            {s.activeBids}
            <span className="text-faint">/{s.maxUnits}</span>
          </Cell>
          <Cell label="Clearing / live">{eth(s.currentClearingPrice)} ETH</Cell>
          <Cell label="Proceeds">{eth(s.proceeds)} ETH</Cell>
          <Cell label="Escrow tracked">{eth(s.totalEscrowed)} ETH</Cell>
          <Cell label="Unreleased">{eth(s.unreleasedProceeds)} ETH</Cell>
          <Cell label="Liabilities">{eth(s.totalLiabilities)} ETH</Cell>
          <Cell label="Surplus">{eth(s.surplusEth)} ETH</Cell>
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-1 mt-3">
          <span className="font-mono text-micro uppercase tracking-[0.12em] text-faint">
            ended / {ended ? "yes" : "no"}
          </span>
          <span className="font-mono text-micro uppercase tracking-[0.12em] text-faint">
            paused / {s.paused ? "yes" : "no"}
          </span>
          <span className="font-mono text-micro uppercase tracking-[0.12em] text-faint">
            frozen clearing /{" "}
            {s.clearingPrice > 0n ? `${eth(s.clearingPrice)} ETH` : "—"}
          </span>
          <span className="font-mono text-micro uppercase tracking-[0.12em] text-faint">
            split 58 / 42
          </span>
          <span className="font-mono text-micro uppercase tracking-[0.12em] text-faint">
            hard end /{" "}
            {s.absoluteEndTime > 0
              ? new Date(s.absoluteEndTime * 1000).toISOString()
              : "—"}
          </span>
        </div>
      </section>

      {/* Settlement */}
      <section className={PANEL}>
        <Label>Settlement</Label>
        <p className="font-sans text-sm text-muted mt-3 mb-5 leading-relaxed max-w-[58ch]">
          After the auction ends, run finalize in batches until the phase reads
          settled. Each batch mints winners and refunds excess; the last splits
          proceeds. Batch 30–45 is a safe size (capped at {MAX_BATCH} here to
          stay under the block gas limit).
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-baseline gap-2 border-b border-line focus-within:border-foreground transition-colors pb-1.5">
            <Label>batch</Label>
            <input
              value={batch}
			  onChange={(e) => setBatch(e.target.value)}
              inputMode="numeric"
              aria-label="Finalize batch size"
			  aria-invalid={!batchValid}
			  aria-describedby={!batchValid ? "batch-size-error" : undefined}
              className="w-14 bg-transparent outline-none font-serif text-lg tabular-nums text-foreground"
            />
          </div>
		  {!batchValid && (
			<span id="batch-size-error" className="font-mono text-micro uppercase text-signal" role="alert">
			  Enter a whole number from 1 to {MAX_BATCH}.
			</span>
		  )}
          {actions.wrongChain ? (
            <button
              className={GHOST}
              onClick={actions.switchToTargetChain}
              disabled={actions.switching}
            >
              {actions.switching ? "switching…" : "switch network"}
            </button>
          ) : (
            <button
              className={PRIMARY}
              disabled={
				writeBlocked ||
				!batchValid ||
                !ended ||
                s.phase === "settled" ||
				s.phase === "cancelled" ||
				s.supplyMismatched ||
				s.mintingUnavailable
              }
              onClick={() => actions.finalize(batchN)}
            >
			  {pendingActionLabel(actions, batchValid ? `finalize ${batchN}` : "invalid batch")}
            </button>
          )}
          {s.phase === "finalizing" && (
            <span className="font-mono text-micro uppercase tracking-[0.12em] text-muted">
              settling {s.finalizeCursor}/{s.winnerCount} minted / proceeds{" "}
              {eth(s.proceeds)} ETH
            </span>
          )}
          {s.phase === "settled" && (
            <span className="font-mono text-micro uppercase tracking-[0.12em] text-up">
              settled / {eth(s.proceeds)} ETH split
            </span>
          )}
        </div>
      </section>

      {/* Failsafe */}
      <section className="border border-signal/30 bg-surface p-6 md:p-7">
        <Label className="text-signal">Failsafe</Label>
        <p className="font-sans text-sm text-muted mt-3 mb-5 leading-relaxed max-w-[58ch]">
          Cancel is only possible before settlement begins, and permanently
          blocks finalize. After cancelling, refundAll is permissionless: any
          wallet can return the remaining bids in batches.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            className={DANGER}
			disabled={writeBlocked || s.phase !== "active"}
            onClick={() => {
              if (
                confirm(
                  "Cancel the auction? This blocks settlement and enables permissionless refunds.",
                )
              ) {
                actions.cancelAuction();
              }
            }}
          >
            cancel auction
          </button>
          {/* Recovery can reach zero live bids with refundsComplete still false (skipped
              already-minted slots); the final call walks the tail and releases proceeds,
              so gate on the flag, never on the bid count. */}
          <button
            className={DANGER}
			disabled={
			  writeBlocked || !batchValid || s.phase !== "cancelled" || s.refundsComplete
			}
            onClick={() => actions.refundAll(batchN)}
          >
            {s.phase === "cancelled" && s.activeBids === 0 && !s.refundsComplete
              ? "finish recovery"
              : `refund all ${batchN}`}
          </button>
          {emergencyAvailable && (
            <button
              className={DANGER}
			  disabled={writeBlocked || !batchValid}
              onClick={() => actions.emergencyRefund(batchN)}
            >
              emergency refund {batchN}
            </button>
          )}
          {s.supplyMismatched &&
            (s.phase === "active" || s.phase === "finalizing") && (
              <button
                className={DANGER}
				disabled={writeBlocked || !batchValid}
                onClick={() => actions.recoverFromSupplyMismatch(batchN)}
              >
                recover supply mismatch {batchN}
              </button>
            )}
		  {mintingRecoveryAvailable && (
			<button
			  className={DANGER}
			  disabled={writeBlocked || !batchValid}
			  onClick={() => actions.recoverFromMintingUnavailable(batchN)}
			>
			  recover unavailable minting {batchN}
			</button>
		  )}
          <button
            className={GHOST}
			disabled={writeBlocked || s.phase !== "active"}
            onClick={() => actions.setPaused(!s.paused)}
          >
            {s.paused ? "unpause bidding" : "pause bidding"}
          </button>
        </div>
        {s.phase === "cancelled" && (
          <p className="font-mono text-micro uppercase tracking-[0.12em] text-muted mt-4">
            {s.refundsComplete
              ? "refunds complete"
              : s.activeBids > 0
                ? `${s.activeBids} bids remaining`
                : "all bids refunded / run the final call to release proceeds"}
          </p>
        )}
      </section>

      {lastTx && (
        <a
          href={getBlockExplorerTxUrl(lastTx)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-micro uppercase tracking-[0.18em] text-muted hover:text-foreground transition-colors"
        >
          view transaction ↗
        </a>
      )}
    </div>,
  );
}

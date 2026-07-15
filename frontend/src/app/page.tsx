"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  LuArrowDown,
  LuChevronsLeft,
  LuChevronsRight,
  LuMaximize2,
  LuMinimize2,
} from "react-icons/lu";
import Header from "@/app/components/Header";
import { WalletPill } from "@/app/components/WalletPill";
import { useToast } from "@/app/components/Toast";
import {
  getBlockExplorerTxUrl,
  PANORAMA_AUCTION_ADDRESS,
  SITE_URL,
} from "@/lib/constants";
import { describeAuctionError } from "@/lib/auctionErrors";
import type { WriteName } from "@/app/auction/hooks/useAuctionActions";
import { useAuctionSession } from "@/app/auction/hooks/useAuctionSession";
import { applyRailMax, readRailMaxAttribute } from "@/lib/railMax";
import { HeroPanorama } from "@/app/auction/components/HeroPanorama";
import { DemoBar } from "@/app/auction/components/DemoBar";
import { Standings } from "@/app/auction/components/Standings";
import { AuctionIntro } from "@/app/auction/components/AuctionIntro";
import {
  pendingActionLabel,
  TransactionStatus,
} from "@/app/components/TransactionStatus";
import {
  displayPhase,
  eth,
  ethCeil,
  ethExact,
  fmtDateUTC,
  Label,
  LiveDot,
  Meter,
  normalizeDecimalInput,
  parseEthInput,
  useChainNow,
  type DisplayPhase,
} from "@/app/auction/components/ui";

const PHASE_COPY: Record<DisplayPhase, string> = {
  upcoming: "Upcoming",
  active: "Live",
  closed: "Closed",
  finalizing: "Settling",
  settled: "Settled",
  cancelled: "Cancelled",
};

const SUCCESS_COPY: Partial<Record<WriteName, string>> = {
  placeBid: "Bid placed.",
  increaseBid: "Bid raised.",
  withdraw: "Refund withdrawn.",
  finalize: "Settlement batch confirmed.",
  refundAll: "Refund batch confirmed.",
  emergencyRefund: "Emergency refund batch confirmed.",
  recoverFromSupplyMismatch: "Recovery batch confirmed.",
  recoverFromMintingUnavailable: "Minting-capability recovery batch confirmed.",
};

// Green primary — matches the terminal's BUY button (#7AE0B5 on near-black),
// a fixed brand green that reads the same in light and dark.
const PRIMARY =
  "w-full font-mono text-xs uppercase tracking-[0.25em] bg-[#7AE0B5] text-[#0a0a0a] py-4 transition-opacity duration-200 hover:opacity-90 active:translate-y-px disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7AE0B5]";
const GHOST =
  "font-mono text-xs uppercase tracking-[0.2em] border border-line px-5 py-3.5 text-foreground transition-colors duration-200 hover:border-foreground active:translate-y-px disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer";
const CHIP =
  "font-mono text-micro uppercase tracking-[0.1em] text-muted border border-line px-2.5 py-1.5 hover:border-foreground hover:text-foreground active:translate-y-px transition-colors duration-200 cursor-pointer";

function Countdown({
  now,
  startTime,
  endTime,
}: {
  now: number;
  startTime: number;
  endTime: number;
}) {
  if (!now)
    return (
      <span className="font-serif text-xl tabular-nums text-faint">··:··</span>
    );
  // Before the sale opens, count down to the start; after, to the end.
  const preStart = now < startTime;
  const target = preStart ? startTime : endTime;
  const left = Math.max(0, target - now);
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const sec = left % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  // Drop the churning seconds until the final hour.
  const text =
    left === 0
      ? "Ended"
      : left >= 3600
        ? `${d > 0 ? `${d}d ` : ""}${pad(h)}:${pad(m)}`
        : `${pad(m)}:${pad(sec)}`;
  return (
    <span className="font-serif font-medium text-xl tabular-nums tracking-[-0.01em] text-foreground leading-none">
      {text}
      {left > 0 && (
        <span className="font-mono text-micro text-faint ml-1.5">
          {preStart ? "to start" : "left"}
        </span>
      )}
    </span>
  );
}

// Scheduled Season 2 auction open, before any contract exists to read a startTime from.
const AUCTION_LAUNCH_MS = Date.UTC(2026, 6, 21, 17, 0, 0); // 21 July 2026, 17:00 UTC
// Scheduled duration (24h) — only used to give the calendar event an end time.
const AUCTION_END_MS = AUCTION_LAUNCH_MS + 24 * 60 * 60 * 1000;

const CAL_TITLE = "Panorama Season 2 Auction opens";
const CAL_DETAILS =
  "The Panorama Season 2 auction (tokens #91-#180) opens. " +
  "Place your bid at https://season2.panorama.garden";

// ICS/Google Calendar timestamp: YYYYMMDDTHHMMSSZ (UTC).
function calStamp(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

const GOOGLE_CAL_URL =
  "https://calendar.google.com/calendar/render?action=TEMPLATE" +
  `&text=${encodeURIComponent(CAL_TITLE)}` +
  `&dates=${calStamp(AUCTION_LAUNCH_MS)}/${calStamp(AUCTION_END_MS)}` +
  `&details=${encodeURIComponent(CAL_DETAILS)}`;

// Pre-deploy countdown to the announced open. Runs off the device clock (there is no chain
// time yet); starts null so the server and first client render match, then ticks every second.
function LaunchCountdown() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left =
    now === null ? null : Math.max(0, Math.floor((AUCTION_LAUNCH_MS - now) / 1000));
  if (left === 0)
    return (
      <span className="font-serif font-medium text-3xl tracking-[-0.02em] text-foreground leading-none">
        Opening now.
      </span>
    );
  const pad = (x: number) => String(x).padStart(2, "0");
  const segments: { value: number | null; label: string }[] = [
    { value: left === null ? null : Math.floor(left / 86400), label: "days" },
    { value: left === null ? null : Math.floor((left % 86400) / 3600), label: "hrs" },
    { value: left === null ? null : Math.floor((left % 3600) / 60), label: "min" },
    { value: left === null ? null : left % 60, label: "sec" },
  ];
  return (
    <div className="flex items-end gap-6 md:gap-8">
      {segments.map((seg) => (
        <div key={seg.label} className="flex flex-col items-start gap-3">
          <span className="font-serif font-medium text-5xl md:text-6xl tabular-nums tracking-[-0.02em] text-foreground leading-none">
            {seg.value === null ? (
              <span className="text-faint">··</span>
            ) : (
              pad(seg.value)
            )}
          </span>
          <span className="font-mono text-micro uppercase tracking-[0.18em] text-faint">
            {seg.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// The announced open, rendered in the visitor's own locale and timezone. Client-only (starts
// null) so the server render and hydration agree instead of formatting in the server's zone.
function LaunchDate() {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    setLabel(
      new Date(AUCTION_LAUNCH_MS).toLocaleString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }),
    );
  }, []);
  return (
    <span className="font-mono text-micro uppercase tracking-[0.14em] text-faint">
      {label ?? "···"}
    </span>
  );
}

export default function AuctionPage() {
  const toast = useToast();
  const {
    demo,
    isConnected,
    address,
    state: s,
    actions,
    controls,
  } = useAuctionSession();
  // Chain-anchored clock: block timestamp + elapsed. The device clock only supplies the
  // seconds since the last block, so local clock skew cannot flip live/ended incorrectly.
  const now = useChainNow(s.chainTime);
  // The contract stays "active" from deploy until finalize; only startTime→endTime
  // is live. Everything status-shaped (label, dot) reads this, not the raw phase.
  const phaseView = displayPhase(s.phase, now, s.startTime, s.endTime);

  const [bidInput, setBidInput] = useState("");
  const [raiseInputs, setRaiseInputs] = useState<Record<number, string>>({});
  const [railOpen, setRailOpen] = useState(true);
  // Desktop-only focus mode: the rail takes the full width and the details pane hides.
  // Mutually exclusive with the collapsed strip; collapsing always exits it. Persisted
  // across reloads (the collapsed strip deliberately is not). The LAYOUT is driven by the
  // html[data-rail-max] attribute + CSS, stamped before first paint so a persisted
  // preference never jumps in after hydration; this state only mirrors it for labels.
  const [railMax, setRailMax] = useState(false);
  useEffect(() => {
    setRailMax(readRailMaxAttribute());
  }, []);
  const updateRailMax = (next: boolean) => {
    setRailMax(next);
    applyRailMax(next);
  };
  // The last submitted tx survives reset() so the explorer link stays after confirmation.
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
      toast.success(
        (actions.lastAction && SUCCESS_COPY[actions.lastAction]) ||
          "Transaction confirmed.",
      );
      setBidInput("");
      setRaiseInputs({});
      actions.reset();
    }
	if (actions.status === "cancelled") {
	  toast.info("Transaction cancelled in your wallet. The auction action was not submitted.");
	  actions.reset();
	}
	if (actions.status === "replaced") {
	  toast.info("A different replacement transaction confirmed. The auction action was not submitted.");
	  actions.reset();
	}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions.status]);

  // Displacement is silent on-chain from this wallet's perspective: the bid simply leaves
  // the top 90 and the ETH is force-returned. Detect the shrink between snapshots and say so.
  const prevBidsRef = useRef<{ address?: string; ids: Set<number> }>({
    ids: new Set(),
  });
  useEffect(() => {
    const prev = prevBidsRef.current;
    const ids = new Set(s.yourBids.map((b) => b.id));
    if (prev.address === address && s.phase === "active" && prev.ids.size > 0) {
      for (const id of prev.ids) {
        if (!ids.has(id)) {
          toast.info(
            "You were outbid. Your ETH was returned to your wallet in full.",
          );
          break;
        }
      }
    }
    prevBidsRef.current = { address, ids };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, s.phase, s.yourBids]);

  // No contract wired up yet (pre-deploy): keep the full page and the details article,
  // but the rail advertises the auction instead of trying to read state that isn't there.
  const comingSoon = !PANORAMA_AUCTION_ADDRESS && !demo;
  const loading = !comingSoon && !demo && !s.ready && !s.readFailed;
  const biddable =
    s.phase === "active" &&
    !s.paused &&
    !s.supplyMismatched &&
    now !== 0 &&
    now >= s.startTime &&
    now < s.endTime;
  const heroClearing =
    s.phase === "settled" ? s.clearingPrice : s.currentClearingPrice;
  const durationHours =
    s.scheduledEndTime > s.startTime
      ? Math.round((s.scheduledEndTime - s.startTime) / 3600)
      : 48;

	const bidNormalized = useMemo(() => normalizeDecimalInput(bidInput), [bidInput]);
  const bidWei = useMemo(() => parseEthInput(bidInput), [bidInput]);
	const bidInvalid =
		bidInput.trim() !== "" &&
		bidNormalized !== "." &&
		bidWei === null;
	const bidTooLow = bidWei !== null && bidWei > 0n && bidWei < s.minimumBid;
	const busy = actions.unresolved;
	// Fail closed like /admin and /recovery: a bid must never ride a stale or degraded
	// snapshot, where minimumBid, endTime, or phase could all be wrong.
	const unsafeSnapshot = s.degraded || s.stale;
	const writeBlocked = busy || unsafeSnapshot;
  const recoveryAvailable = s.phase === "cancelled" && !s.refundsComplete;
  const emergencyAvailable =
    now !== 0 &&
    now > s.emergencyEligibleAt &&
    (s.phase === "active" || s.phase === "finalizing");
  const supplyRecoveryAvailable =
    s.supplyMismatched && (s.phase === "active" || s.phase === "finalizing");
	const mintingRecoveryAvailable =
	  !supplyRecoveryAvailable &&
	  s.mintingUnavailable &&
	  now !== 0 &&
	  now >= s.finalizeEligibleAt &&
	  (s.phase === "active" || s.phase === "finalizing");
  const finalizeOpenToAll =
    now !== 0 &&
    s.finalizeEligibleAt > 0 &&
    now >= s.finalizeEligibleAt &&
    (s.phase === "active" || s.phase === "finalizing") &&
		now >= s.endTime &&
		!s.supplyMismatched &&
		!s.mintingUnavailable;

  const statusNote = (() => {
    if (s.phase === "settled")
      return "Settled. Winners minted highest-first; excess refunded.";
    if (s.phase === "cancelled")
      return s.refundsComplete
        ? "Cancelled. All remaining bids have been refunded."
        : s.activeBids > 0
          ? `Cancelled. ${s.activeBids} refund${s.activeBids === 1 ? "" : "s"} remaining; anyone can process them.`
          : "Cancelled. One final call completes the recovery; anyone can send it.";
    if (s.phase === "finalizing")
      return "Settling now. Winners are being minted, highest bid first.";
    if (s.supplyMismatched)
      return "Collection supply changed unexpectedly. Bidding is closed; recovery is available below.";
    if (s.paused) return "Bidding is paused.";
    if (now !== 0 && now < s.startTime) return "Bidding opens soon.";
    if (now !== 0 && now >= s.endTime)
      return "Bidding closed. Awaiting settlement.";
    return "";
  })();

  const railBody = comingSoon ? (
    <div className="flex flex-col gap-10 py-10 md:py-14">
      <div className="flex flex-col gap-5">
        <span className="font-mono text-micro uppercase tracking-[0.24em] text-faint">
          Bidding opens in
        </span>
        <LaunchCountdown />
        <LaunchDate />
        <a
          href={GOOGLE_CAL_URL}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-micro uppercase tracking-[0.18em] text-muted hover:text-foreground transition-colors pt-1"
        >
          Add to Google Calendar ↗
        </a>
      </div>
      <p className="font-sans text-base text-muted leading-relaxed max-w-[38ch]">
        The Season 2 auction is not live yet. Read the full details on the right,
        and check back to place your bid when it opens.
      </p>
      <div className="flex flex-col gap-5 pt-2">
        <a
          href={SITE_URL}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-micro uppercase tracking-[0.18em] text-muted hover:text-foreground transition-colors"
        >
          Enter Panorama ↗
        </a>
        <a
          href={`${SITE_URL}/terminal`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-micro uppercase tracking-[0.18em] text-muted hover:text-foreground transition-colors"
        >
          Go to terminal ↗
        </a>
      </div>
    </div>
  ) : loading ? (
    <div className="flex flex-col gap-3 py-10 items-center text-center">
      <Label>Loading</Label>
      <p className="font-sans text-sm text-muted">Reading the auction state…</p>
    </div>
  ) : s.readFailed && !demo ? (
    <div
      className="flex flex-col gap-3 py-10 items-center text-center"
      role="alert"
    >
      <Label className="text-signal">Connection problem</Label>
      <p className="font-sans text-sm text-muted max-w-[32ch]">
        The auction state could not be loaded. Check your connection; retrying
        automatically.
      </p>
      <button className={GHOST} onClick={() => s.refetch()}>
        retry now
      </button>
    </div>
  ) : (
    <>
      {demo && controls && <DemoBar controls={controls} />}

      {/* Status header: phase + countdown on the left, wallet + collapse on the right */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <span className="inline-flex items-center gap-2">
            <LiveDot phase={phaseView} />
            <span className="font-mono text-micro uppercase tracking-[0.2em] text-muted">
              {PHASE_COPY[phaseView]}
            </span>
          </span>
          <Countdown now={now} startTime={s.startTime} endTime={s.endTime} />
          {s.extensionCount > 0 && (
            <span className="font-mono text-micro uppercase tracking-[0.12em] text-faint">
              extended {s.extensionCount}× / hard end{" "}
              {fmtDateUTC(s.absoluteEndTime)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!demo && <WalletPill />}
          <button
            type="button"
            onClick={() => updateRailMax(!railMax)}
            title={railMax ? "Exit full width" : "Full width"}
            aria-label={
              railMax
                ? "Exit full-width bids panel"
                : "Expand bids panel to full width"
            }
            className="hidden lg:inline-flex items-center justify-center w-8 h-8 text-faint hover:text-foreground transition-colors cursor-pointer shrink-0"
          >
            {/* Both icons render; CSS keyed on html[data-rail-max] shows the right one,
                so a persisted preference never swaps icons after hydration. */}
            <span className="rail-icon-max inline-flex">
              <LuMaximize2 size={14} />
            </span>
            <span className="rail-icon-restore inline-flex">
              <LuMinimize2 size={14} />
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              updateRailMax(false);
              setRailOpen(false);
            }}
            title="Collapse"
            aria-label="Collapse bids panel"
            className="hidden lg:inline-flex items-center justify-center w-8 h-8 text-faint hover:text-foreground transition-colors cursor-pointer shrink-0"
          >
            <LuChevronsLeft size={16} />
          </button>
        </div>
      </div>

      {s.degradedPersistent && (
        <div
          className="border border-signal/50 px-4 py-3 flex items-center justify-between gap-4"
          role="alert"
        >
          <p className="font-sans text-sm text-muted">
            Live auction data is stale or degraded. Bidding stays locked until a
            refresh succeeds.
          </p>
          <button className={GHOST} onClick={() => s.refetch()}>
            retry
          </button>
        </div>
      )}

	  <TransactionStatus actions={actions} />

      {/* Primary module: how full the sale is, and the way to act on it. Two raised panels,
          separated by space and depth rather than a rule. */}
      <div className="flex flex-col gap-4">
        {/* Capacity */}
        <div className="bg-surface p-5 flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <Label>Slots filled</Label>
            <span className="font-serif font-medium text-lg tabular-nums text-foreground leading-none">
              {s.activeBids}
              <span className="text-faint">/{s.maxUnits}</span>
            </span>
          </div>
          <Meter filled={s.activeBids} total={s.maxUnits} />
        </div>

        {/* Action — place a bid, or the reason you can't right now */}
        <div className="bg-surface p-5">
          {statusNote && !biddable ? (
            <p className="font-sans text-sm text-muted leading-relaxed">
              {statusNote}
              {finalizeOpenToAll && (
                <>
                  {" "}
                  <Link
                    href="/recovery"
                    className="text-foreground underline hover:opacity-60"
                  >
                    Anyone can settle it now.
                  </Link>
                </>
              )}
            </p>
          ) : !isConnected ? (
            <div className="flex flex-col gap-3">
              <Label>Place a bid</Label>
              <p className="font-sans text-sm text-muted">
                Connect a wallet to place your bid.
              </p>
              <WalletPill connectLabel="connect wallet" />
            </div>
          ) : s.yourBidCount >= s.maxBidsPerWallet ? (
            <div className="flex flex-col gap-2">
              <Label>Place a bid</Label>
              <p className="font-sans text-sm text-muted leading-relaxed">
                You&apos;re holding all {s.maxBidsPerWallet} bids. Raise one
                below to bid higher.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Label>Place a bid</Label>
              <div className="flex items-baseline gap-3 border-b border-line focus-within:border-foreground transition-colors duration-200 pb-3">
                <input
                  value={bidInput}
				  onChange={(e) => setBidInput(e.target.value)}
                  inputMode="decimal"
                  placeholder={ethCeil(s.minimumBid)}
                  aria-label="Bid amount in ETH"
				  aria-invalid={bidInvalid}
				  aria-describedby={bidInvalid ? "bid-amount-error" : undefined}
                  className="bg-transparent outline-none font-serif font-medium text-2xl tabular-nums w-full text-foreground placeholder:text-faint placeholder:font-normal"
                />
                <span className="font-mono text-xs uppercase tracking-[0.12em] text-muted">
                  ETH
                </span>
              </div>
			  {bidInvalid && (
			    <p
				  id="bid-amount-error"
				  className="font-mono text-micro uppercase tracking-[0.12em] text-signal"
				  role="alert"
			    >
				  Enter one plain decimal amount, for example 0.15 or 0,15.
			    </p>
			  )}
              <div className="flex items-center justify-between gap-3">
                {/* One button. minimumBid already resolves to the reserve while slots
                    are open, and the lowest winning bid + increment once full. */}
                <button
                  type="button"
                  onClick={() => setBidInput(ethExact(s.minimumBid))}
                  className={CHIP}
                >
                  min {ethCeil(s.minimumBid)} ETH
                </button>
                {bidTooLow && (
                  <span className="font-mono text-micro uppercase tracking-[0.12em] text-signal">
                    below minimum
                  </span>
                )}
              </div>
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
				    !biddable ||
				    bidInvalid ||
				    bidWei === null ||
				    bidWei < s.minimumBid
				  }
				  onClick={() => {
				    if (bidWei !== null && biddable) {
					  actions.placeBid(bidWei);
				    }
				  }}
                >
				  {pendingActionLabel(actions, "place bid")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Your bids */}
      {isConnected && s.yourBids.length > 0 && (
        <div>
          <Label>Your bids / {s.yourBids.length}</Label>
          <ul className="mt-3 flex flex-col gap-2">
            {s.yourBids.map((b) => {
			  const raiseRaw = raiseInputs[b.id] || "";
			  const raiseWei = parseEthInput(raiseRaw);
			  const raiseNormalized = normalizeDecimalInput(raiseRaw);
			  const raiseInvalid =
				raiseRaw.trim() !== "" && raiseNormalized !== "." && raiseWei === null;
              const inExtensionWindow = now !== 0 && now + 5 * 60 >= s.endTime;
              const raiseTooLow =
                inExtensionWindow &&
				raiseWei !== null &&
				raiseWei > 0n &&
				raiseWei < s.minIncreaseForExtension;
              return (
                <li
                  key={b.id}
                  className="flex items-center gap-3 bg-surface px-3 py-2.5"
                >
                  <span className="font-serif text-base tabular-nums text-foreground w-20">
                    {eth(b.amount)}{" "}
                    <span className="font-mono text-micro text-faint">
                      ETH
                    </span>
                  </span>
                  {s.phase === "active" && (
                    <span className="font-mono text-micro uppercase tracking-[0.14em] text-up">
                      winning
                    </span>
                  )}
                  {biddable && (
					<div className="flex flex-wrap items-center justify-end gap-2 ml-auto">
                      <input
                        value={raiseInputs[b.id] ?? ""}
						onChange={(e) =>
						  setRaiseInputs((p) => ({ ...p, [b.id]: e.target.value }))
						}
                        inputMode="decimal"
                        placeholder={
                          inExtensionWindow
                            ? `+ ${ethCeil(s.minIncreaseForExtension)}`
                            : "+ eth"
                        }
                        aria-label="Raise amount in ETH"
						aria-invalid={raiseInvalid}
                        className="w-16 bg-transparent border-b border-line focus:border-foreground outline-none font-mono text-xs tabular-nums text-foreground placeholder:text-faint pb-1 transition-colors"
                      />
                      <button
                        type="button"
						disabled={
						  writeBlocked ||
						  !biddable ||
						  raiseInvalid ||
						  raiseWei === null ||
						  raiseWei === 0n ||
						  raiseTooLow
						}
						onClick={() => {
						  if (raiseWei !== null && biddable) {
							actions.increaseBid(b.id, raiseWei);
						  }
						}}
                        className="font-mono text-micro uppercase tracking-[0.14em] text-foreground hover:opacity-60 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity cursor-pointer"
                      >
						{raiseInvalid
						  ? "invalid amount"
						  : raiseTooLow
							? "min too low"
							: pendingActionLabel(actions, "raise")}
                      </button>
					{raiseInvalid && (
					  <span className="basis-full font-mono text-micro text-signal text-right" role="alert">
						Use one decimal number; comma is accepted.
					  </span>
					)}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Pending refund */}
      {isConnected && s.yourPending > 0n && (
        <div className="bg-surface p-4 flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <Label>Refund available</Label>
            <span className="font-serif text-lg tabular-nums text-foreground">
              {eth(s.yourPending)}{" "}
              <span className="font-mono text-xs text-muted">ETH</span>
            </span>
          </div>
          <button
            className={GHOST}
				disabled={writeBlocked}
				onClick={() => {
				  if (!writeBlocked) actions.withdraw();
				}}
          >
            {busy ? "…" : "withdraw"}
          </button>
        </div>
      )}

      {/* Permissionless recovery */}
      {(recoveryAvailable ||
        emergencyAvailable ||
		supplyRecoveryAvailable ||
		mintingRecoveryAvailable) && (
        <div className="bg-signal/10 p-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label>Permissionless recovery</Label>
            <p className="font-sans text-sm text-muted leading-relaxed">
              {supplyRecoveryAvailable
                ? `Panorama supply no longer matches the required ${s.expectedNftSupply}. Settlement cannot safely continue; remaining bids can be refunded.`
				: mintingRecoveryAvailable
				  ? `Settlement minting is unavailable after the grace period. The auction needs a mint cap of ${s.requiredMintCapForSettlement}; any wallet can move the unminted bids into recovery.`
                : recoveryAvailable
                  ? s.activeBids > 0
                    ? `${s.activeBids} bids still need refunds. Any wallet can process the next batch.`
                    : "All bids are refunded. One final call releases the remaining accounting; any wallet can send it."
                  : "The hard emergency deadline has passed. Any wallet can stop settlement and refund every unminted bid."}
            </p>
          </div>
          {!isConnected ? (
            <WalletPill connectLabel="connect to recover" />
          ) : actions.wrongChain ? (
            <button
              className={GHOST}
              onClick={actions.switchToTargetChain}
              disabled={actions.switching}
            >
              {actions.switching ? "switching…" : "switch network"}
            </button>
          ) : (
            <button
              className={GHOST}
			  disabled={writeBlocked}
			  onClick={() =>
				!writeBlocked && supplyRecoveryAvailable
				  ? actions.recoverFromSupplyMismatch(45)
				  : !writeBlocked && mintingRecoveryAvailable
					? actions.recoverFromMintingUnavailable(45)
				  : !writeBlocked && recoveryAvailable
					? actions.refundAll(45)
					: !writeBlocked
						? actions.emergencyRefund(45)
						: undefined
			  }
            >
              {busy
                ? "confirming…"
                : supplyRecoveryAvailable
                  ? "recover from supply mismatch"
				  : mintingRecoveryAvailable
					? "recover unavailable minting"
                  : recoveryAvailable
                    ? s.activeBids > 0
                      ? "refund next 45"
                      : "finish recovery"
                    : "start emergency refund"}
            </button>
          )}
          <Link
            href="/recovery"
            className="font-mono text-micro uppercase tracking-[0.14em] text-muted hover:text-foreground transition-colors"
          >
            all recovery tools →
          </Link>
        </div>
      )}

      {/* Standings — live bids and minted winners (rail scrolls). Hidden before the sale
          opens: there is nothing to rank yet. */}
      {phaseView !== "upcoming" && (
        <Standings
          bids={s.allBids}
          won={s.wonBids}
          firstTokenId={s.firstTokenId}
          you={address}
          activeBids={s.activeBids}
          maxUnits={s.maxUnits}
          isFull={s.isFull}
          clearing={heroClearing}
          phase={s.phase}
          enableEns={!demo}
          wonStatus={s.wonStatus}
          wonExpectedCount={s.wonExpectedCount}
          wonIntegrityIssue={s.wonIntegrityIssue}
          onRetryWon={s.refetchWon}
        />
      )}

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
    </>
  );

  return (
    <div className="min-h-dvh flex flex-col bg-background text-foreground">
      <Header />
      <div className="h-16 shrink-0" />

      {/* HERO — together with the 64px header offset, the panorama and masthead fill exactly
          one screen. The image flexes around the text so this remains true on every viewport. */}
      <section className="w-full h-[calc(100dvh-4rem)] flex flex-col">
        <div className="mt-4 md:mt-6 flex-1 min-h-0">
          <HeroPanorama />
        </div>
        <div className="mx-auto w-full 4xl:max-w-[2400px] min-[3440px]:max-w-[2720px] px-5 md:px-10 xl:px-14 4xl:px-16 pt-8 md:pt-12 lg:pt-8 pb-8 md:pb-10">
          <div className="lg:grid lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1.1fr)] lg:gap-x-10 xl:gap-x-14 lg:items-start">
            <div>
              <h1 className="font-serif font-medium leading-[1.02] tracking-[-0.02em] text-foreground text-balance text-[clamp(2rem,1rem+3.1vw,3.5rem)]">
                Panorama S2: Anthology of Mankind.
              </h1>
            </div>
            <div className="mt-6 lg:mt-0">
              <p className="font-sans text-muted leading-relaxed text-pretty max-w-[62ch] text-[clamp(1rem,0.94rem+0.3vw,1.2rem)]">
                Panorama, in its second season, traces humanity&apos;s journey from the Stone Age
                through artificial intelligence. Across ninety connected paintings, it follows
                inventions that shaped civilization and choices still shaping our future.
              </p>
              {/* Scroll cue as a quiet control: muted arrow + label, brightens and nudges on hover. */}
              <button
                type="button"
                onClick={() => {
                  const el = document.getElementById("sale");
                  if (el)
                    window.scrollTo({
                      top: el.getBoundingClientRect().top + window.scrollY - 64,
                      behavior: "smooth",
                    });
                }}
                aria-label="Scroll to bidding and details"
                className="group mt-6 inline-flex items-center gap-2.5 text-faint hover:text-foreground transition-colors cursor-pointer"
              >
                <LuArrowDown
                  size={14}
                  className="transition-transform duration-300 group-hover:translate-y-0.5"
                />
                <span className="font-mono text-micro uppercase tracking-[0.2em]">
                  Bid and full details
                </span>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* TWO PANES — bidding rail (sticky on desktop) and the details article. The inner row is
          capped + centered so ultrawide slack becomes symmetric outer margin instead of a
          mid-pane void. The only rule on the page is the rail / content divider below. */}
      <div className="w-full scroll-mt-16" id="sale">
      <div className="flex flex-col lg:flex-row mx-auto w-full 4xl:max-w-[2400px] min-[3440px]:max-w-[2720px]">
        {/* Bidding: mobile FIRST, desktop LEFT and sticky so it stays usable while reading. */}
        <aside
          className={`rail-aside lg:shrink-0 border-b lg:border-b-0 lg:border-r border-line lg:sticky lg:self-start lg:top-16 lg:max-h-[calc(100dvh-4rem)] lg:overflow-y-auto overlay-scroll-content transition-[width] duration-300 ${
            railOpen
              ? "lg:w-[420px] xl:w-[500px] 2xl:w-[560px] 3xl:w-[760px] 4xl:w-[1000px] min-[3440px]:w-[1240px]"
              : "lg:w-[46px]"
          }`}
          style={{ transitionTimingFunction: "var(--ease-out)" }}
        >
          {/* Collapsed strip (desktop only) */}
          {!railOpen && (
            <button
              type="button"
              onClick={() => setRailOpen(true)}
              title="Expand bids"
              aria-label="Expand bids panel"
              className="hidden lg:flex flex-col items-center gap-5 w-full py-4 hover:bg-foreground/[0.03] transition-colors cursor-pointer group"
            >
              <LuChevronsRight
                size={16}
                className="text-muted group-hover:text-foreground"
              />
              <span className="font-mono text-micro uppercase tracking-[0.24em] text-muted [writing-mode:vertical-rl] rotate-180">
                Bids {s.activeBids}/{s.maxUnits}
              </span>
              <LiveDot phase={phaseView} />
            </button>
          )}

          {/* Full content: always on mobile, on desktop only when open. In full-width mode
              (CSS, keyed on html[data-rail-max]) the content stays centered at a readable
              width instead of stretching. */}
          <div
            className={`rail-content ${railOpen ? "" : "lg:hidden"} flex flex-col gap-6 p-5 md:p-6 animate-modal-in`}
          >
            {railBody}
          </div>
        </aside>

        {/* Details — the deeper read: the work, the sale, how it works, and the FAQ.
            Hidden by CSS while the rail is maximized. */}
        <main className="rail-details lg:flex-1 lg:min-w-0">
          <AuctionIntro
            durationHours={durationHours}
            incrementPct={s.minIncrementBps ? s.minIncrementBps / 100 : 5}
            reserve={s.reservePrice > 0n ? eth(s.reservePrice) : "0.1"}
            hardEndLabel={
              s.absoluteEndTime > 0 ? fmtDateUTC(s.absoluteEndTime) : undefined
            }
          />
        </main>
      </div>
      </div>
    </div>
  );
}

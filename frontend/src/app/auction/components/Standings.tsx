"use client";

import { useEffect, useRef, useState } from "react";
import { useAddressLabel } from "@/app/hooks/useAddressLabel";
import type {
	AuctionBidRow,
	AuctionPhase,
	WonLogStatus,
	WonRow,
} from "../hooks/useAuctionState";
import { eth, Label, short } from "./ui";
import { StandingsInfoModal } from "./StandingsInfoModal";

/** One row of the board. Resolves ENS (mainnet) unless disabled (demo). */
function BidRow({
	bidder,
	amount,
	rank,
	tag,
	mine,
	maxAmount,
	enableEns,
	dim,
}: {
	bidder: `0x${string}`;
	amount: bigint;
	rank: number | null;
	tag?: string; // e.g. "minted" / "refunding"
	mine: boolean;
	maxAmount: bigint;
	enableEns: boolean;
	dim?: boolean;
}) {
	const rowRef = useRef<HTMLLIElement>(null);
	const [resolveEns, setResolveEns] = useState(false);
	useEffect(() => {
		if (!enableEns || mine || resolveEns) return;
		const row = rowRef.current;
		if (!row || typeof IntersectionObserver === "undefined") {
			setResolveEns(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				setResolveEns(true);
				observer.disconnect();
			},
			{ rootMargin: "240px 0px" },
		);
		observer.observe(row);
		return () => observer.disconnect();
	}, [enableEns, mine, resolveEns]);
	const ens = useAddressLabel(enableEns && !mine && resolveEns ? bidder : null);
	const display = mine ? "you" : ens || short(bidder);
	const pct = maxAmount > 0n ? Math.max(4, Number((amount * 10_000n) / maxAmount) / 100) : 0;

	return (
		<li
			ref={rowRef}
			className={`relative flex items-center h-10 pl-3 pr-3 ${dim ? "opacity-45" : ""}`}
		>
			<span
				aria-hidden
				className="absolute inset-y-[6px] left-0 transition-[width] duration-500"
				style={{
					width: `${pct}%`,
					transitionTimingFunction: "var(--ease-out)",
					background: mine
						? "color-mix(in srgb, var(--foreground) 11%, transparent)"
						: "color-mix(in srgb, var(--foreground) 4%, transparent)",
				}}
			/>
			{mine && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-foreground" />}

			<span className="relative font-mono text-micro tabular-nums text-faint w-9 shrink-0">
				{rank === null ? "—" : `#${rank}`}
			</span>
			<span
				className={`relative font-mono text-xs flex-1 truncate ${mine ? "text-foreground" : "text-muted"}`}
			>
				{display}
				{tag && (
					<span className="font-mono text-micro uppercase tracking-[0.1em] text-faint ml-2">{tag}</span>
				)}
			</span>
			<span className="relative font-serif tabular-nums text-foreground shrink-0">
				{eth(amount)}
				<span className="font-mono text-micro uppercase tracking-[0.1em] text-faint ml-1">ETH</span>
			</span>
		</li>
	);
}

/**
 * The board. While bidding it ranks the live top-90. Once settlement starts, minted winners
 * come from Won events (they are deleted from contract storage as they mint), so rankings do
 * not restart mid-settlement and the final board persists after the auction is over.
 */
export function Standings({
	bids,
	won = [],
	firstTokenId,
	you,
	activeBids,
	maxUnits,
	isFull,
	clearing,
	phase,
	enableEns,
	wonStatus,
	wonExpectedCount,
	wonIntegrityIssue,
	onRetryWon,
}: {
	bids: AuctionBidRow[]; // live bids, sorted high -> low
	won?: WonRow[]; // minted winners, sorted by tokenId (mint order = bid order)
	firstTokenId: number;
	you?: string;
	activeBids: number;
	maxUnits: number;
	isFull: boolean;
	clearing: bigint;
	phase: AuctionPhase;
	enableEns: boolean;
	wonStatus: WonLogStatus;
	wonExpectedCount: number;
	wonIntegrityIssue?: string;
	onRetryWon: () => void;
}) {
	const [infoOpen, setInfoOpen] = useState(false);
	const youLc = you?.toLowerCase();
	const showWon = won.length > 0;
	const maxAmount =
		[...won.map((w) => w.amount), ...bids.map((b) => b.amount)].reduce(
			(hi, a) => (a > hi ? a : hi),
			0n,
		) || 1n;
	const total = showWon || phase !== "active" ? won.length + bids.length : activeBids;
	const empty = bids.length === 0 && won.length === 0;
	const wonHistoryPending = wonStatus === "loading";
	const wonHistoryUnsafe = wonStatus === "error" || wonStatus === "degraded";

	return (
		<section className="flex flex-col">
			<div className="flex items-baseline justify-between gap-3">
				<div className="flex items-baseline gap-3">
					<Label>Standings</Label>
					<button
						type="button"
						onClick={() => setInfoOpen(true)}
						className="font-mono text-micro uppercase tracking-[0.1em] text-muted hover:text-foreground underline underline-offset-2 decoration-line hover:decoration-foreground transition-colors cursor-pointer"
					>
						How it works
					</button>
				</div>
				<span className="font-mono text-micro tabular-nums text-faint">
					{total} / {maxUnits}
				</span>
			</div>
				{(wonHistoryPending || wonHistoryUnsafe) && (
					<div
						className={`mt-3 border px-3 py-3 flex flex-col gap-2 ${
							wonHistoryUnsafe ? "border-signal/50" : "border-line"
						}`}
						role={wonHistoryUnsafe ? "alert" : "status"}
					>
						<p className="font-sans text-xs text-muted leading-relaxed">
							{wonHistoryPending
								? `Loading minted winner history (${won.length}/${wonExpectedCount})…`
								: `${wonIntegrityIssue ?? "Winner history could not be verified."} Final standings are not being reported as complete.`}
						</p>
						{wonHistoryUnsafe && (
							<button
								type="button"
								onClick={onRetryWon}
								className="self-start font-mono text-micro uppercase tracking-[0.14em] text-foreground underline hover:opacity-60"
							>
								retry winner history
							</button>
						)}
					</div>
				)}

				{empty ? (
					<p className="font-sans text-sm text-muted mt-4 py-8 text-center border-t border-line">
						{phase === "active"
							? "No bids yet. The highest bid takes #1."
							: wonHistoryPending || wonHistoryUnsafe || wonExpectedCount > 0
								? "Winner history is not complete yet."
								: "Closed with no bids."}
					</p>
			) : (
				<>
					{(wonHistoryPending || wonHistoryUnsafe) && (
						<p className="font-sans text-xs text-muted mt-2 mb-3 leading-relaxed">
							Minted rows are shown only as far as winner history can currently be verified.
						</p>
					)}
					<ol className="mt-3 border-t border-line divide-y divide-line/60">
						{won.map((w) => (
							<BidRow
								key={`won-${w.tokenId}`}
								bidder={w.bidder}
								amount={w.amount}
								rank={w.tokenId - firstTokenId + 1}
								tag="minted"
								mine={w.bidder.toLowerCase() === youLc}
								maxAmount={maxAmount}
								enableEns={enableEns}
							/>
						))}
						{bids.map((b, i) => (
							<BidRow
								key={b.id}
								bidder={b.bidder}
								amount={b.amount}
								rank={phase === "cancelled" ? null : won.length + i + 1}
								tag={phase === "cancelled" ? "refund due" : undefined}
								mine={b.bidder.toLowerCase() === youLc}
								maxAmount={maxAmount}
								enableEns={enableEns}
								dim={phase === "cancelled"}
							/>
						))}
					</ol>

					{isFull && phase === "active" && (
						<div className="flex items-center justify-between border-y border-line/70 py-2.5 mt-1">
							<span className="font-mono text-micro uppercase tracking-[0.14em] text-signal/80">
								clearing floor
							</span>
							<span className="font-mono text-micro tabular-nums text-foreground">
								{eth(clearing)} ETH / everyone pays this
							</span>
						</div>
					)}
					{phase === "settled" && (
						<div className="flex items-center justify-between border-y border-line/70 py-2.5 mt-1">
							<span className="font-mono text-micro uppercase tracking-[0.14em] text-muted">
								settled price
							</span>
							<span className="font-mono text-micro tabular-nums text-foreground">
								{eth(clearing)} ETH / every winner paid this
							</span>
						</div>
					)}
				</>
			)}

			{infoOpen && <StandingsInfoModal onClose={() => setInfoOpen(false)} />}
		</section>
	);
}

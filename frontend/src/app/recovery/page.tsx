"use client";

import { useEffect, useState } from "react";
import Header from "@/app/components/Header";
import { WalletPill } from "@/app/components/WalletPill";
import { useToast } from "@/app/components/Toast";
import {
	BLOCK_EXPLORER_URL,
	getBlockExplorerTxUrl,
	PANORAMA_AUCTION_ADDRESS,
} from "@/lib/constants";
import { describeAuctionError } from "@/lib/auctionErrors";
import { useAuctionSession } from "@/app/auction/hooks/useAuctionSession";
import {
	displayPhase,
	eth,
	fmtDateUTC,
	Label,
	LiveDot,
	useChainNow,
} from "@/app/auction/components/ui";
import {
	pendingActionLabel,
	TransactionStatus,
} from "@/app/components/TransactionStatus";

const GHOST =
	"font-mono text-xs uppercase tracking-[0.2em] border border-line px-5 py-3 text-foreground transition-colors duration-200 hover:border-foreground active:translate-y-px disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer";

const BATCH = 45;

type ToolStatus = "available" | "scheduled" | "inactive" | "done";

function StatusTag({ status, note }: { status: ToolStatus; note: string }) {
	const color =
		status === "available"
			? "text-up border-up/40"
			: status === "done"
				? "text-muted border-line"
				: "text-faint border-line";
	return (
		<span
			className={`font-mono text-micro uppercase tracking-[0.14em] border px-2 py-1 ${color}`}
		>
			{note}
		</span>
	);
}

function Tool({
	title,
	children,
	status,
	note,
	action,
}: {
	title: string;
	children: React.ReactNode;
	status: ToolStatus;
	note: string;
	action?: React.ReactNode;
}) {
	return (
		<li className="border-t border-line py-6 flex flex-col gap-3">
			<div className="flex items-center justify-between gap-4">
				<h3 className="font-serif font-medium text-lg text-foreground">{title}</h3>
				<StatusTag status={status} note={note} />
			</div>
			<p className="font-sans text-sm text-muted leading-relaxed max-w-[62ch]">{children}</p>
			{action && <div className="flex items-center gap-3">{action}</div>}
		</li>
	);
}

export default function RecoveryPage() {
	const toast = useToast();
	const { demo, isConnected, state: s, actions } = useAuctionSession();
	const now = useChainNow(s.chainTime);
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
			toast.info("Transaction cancelled in your wallet. No recovery action was submitted.");
			actions.reset();
		}
		if (actions.status === "replaced") {
			toast.info("A different replacement transaction confirmed. No recovery action was submitted.");
			actions.reset();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [actions.status]);

	const busy = actions.unresolved;
	const unsafeSnapshot = s.degraded || s.stale;
	const writeBlocked = busy || unsafeSnapshot;
	const ended = now !== 0 && s.endTime > 0 && now >= s.endTime;
	const settledOrRecovered =
		s.phase === "settled" || (s.phase === "cancelled" && s.refundsComplete);

	// Availability, mirroring the contract's own gates.
	const finalizeOpen =
		ended &&
		now >= s.finalizeEligibleAt &&
		(s.phase === "active" || s.phase === "finalizing") &&
		!s.supplyMismatched &&
		!s.mintingUnavailable;
	const cancelledRefunds = s.phase === "cancelled" && !s.refundsComplete;
	const mismatchOpen =
		s.supplyMismatched && (s.phase === "active" || s.phase === "finalizing");
	const mintingUnavailableOpen =
		!mismatchOpen &&
		s.mintingUnavailable &&
		now !== 0 &&
		now >= s.finalizeEligibleAt &&
		(s.phase === "active" || s.phase === "finalizing");
	const emergencyOpen =
		now !== 0 && now > s.emergencyEligibleAt && s.phase !== "settled" && !settledOrRecovered;

	const connectGate = !isConnected ? (
		<WalletPill connectLabel="connect a wallet" />
	) : actions.wrongChain ? (
		<button className={GHOST} onClick={actions.switchToTargetChain} disabled={actions.switching}>
			{actions.switching ? "switching…" : "switch network"}
		</button>
	) : null;

	const etherscanFallback = PANORAMA_AUCTION_ADDRESS ? (
		<a
			href={`${BLOCK_EXPLORER_URL}/address/${PANORAMA_AUCTION_ADDRESS}#writeContract`}
			target="_blank"
			rel="noreferrer"
			className="font-mono text-micro uppercase tracking-[0.14em] text-muted hover:text-foreground transition-colors"
		>
			or call it on Etherscan ↗
		</a>
	) : null;

	return (
		<div className="min-h-screen bg-background text-foreground flex flex-col">
			<Header />
			<div className="h-20 shrink-0" />
			<main className="mx-auto w-full max-w-[760px] 3xl:max-w-[920px] 4xl:max-w-[1120px] min-[3440px]:max-w-[1320px] px-5 md:px-10 3xl:px-16 4xl:px-24 pb-32 animate-modal-in">
				<div className="flex items-center justify-between gap-4 pt-4 md:pt-8">
					<div className="flex items-center gap-3">
						<LiveDot phase={displayPhase(s.phase, now, s.startTime, s.endTime)} />
						<Label>Panorama Season 2 auction</Label>
					</div>
					{!demo && <WalletPill />}
				</div>

				<h1 className="font-serif font-medium text-2xl md:text-3xl leading-[1.05] tracking-[-0.01em] mt-6">
					Your ETH does not depend on us.
				</h1>
				<div className="mt-6 flex flex-col gap-4 font-sans text-base text-muted leading-relaxed">
					<p>
						Every bid is held by the auction contract, never by a person. The owner cannot
						redirect escrow. Payout addresses are fixed at deployment. Each recovery path below
						is enforced by the contract itself, and each one can be triggered by any wallet once
						its condition is met.
					</p>
					<p>
						If this page is ever unreachable, every function here can be called directly on the
						verified contract via Etherscan.
					</p>
				</div>

					{!PANORAMA_AUCTION_ADDRESS && !demo ? (
						<p className="font-sans text-sm text-muted mt-10 border-t border-line pt-6">
							The auction contract is not configured yet.
						</p>
					) : !demo && !s.ready && !s.readFailed ? (
						<div className="mt-10 border-t border-line pt-6 flex flex-col gap-2" role="status">
							<Label>Loading</Label>
							<p className="font-sans text-sm text-muted">Reading recovery eligibility…</p>
						</div>
					) : !demo && s.readFailed ? (
						<div className="mt-10 border-t border-line pt-6 flex flex-col items-start gap-3" role="alert">
							<Label className="text-signal">Connection problem</Label>
							<p className="font-sans text-sm text-muted">
								Recovery state could not be verified. Every recovery write remains locked.
							</p>
							<button className={GHOST} onClick={() => s.refetch()}>retry now</button>
						</div>
					) : (
						<>
							{unsafeSnapshot && (
								<div className="mt-10 border border-signal/50 px-4 py-3 flex items-center justify-between gap-4" role="alert">
									<p className="font-sans text-sm text-muted">
										Recovery reads are stale or degraded. Writes remain locked until refresh succeeds.
									</p>
									<button className={GHOST} onClick={() => s.refetch()}>retry</button>
								</div>
							)}
							<div className={unsafeSnapshot ? "mt-4" : "mt-10"}>
								<TransactionStatus actions={actions} />
							</div>
						<ol className="mt-4 flex flex-col">
						<Tool
							title="Withdraw a ledgered refund"
							status={s.yourPending > 0n ? "available" : "inactive"}
							note={s.yourPending > 0n ? `${eth(s.yourPending)} ETH waiting` : "nothing owed to this wallet"}
							action={
								s.yourPending > 0n
									? (connectGate ?? (
											<button className={GHOST} disabled={writeBlocked} onClick={() => actions.withdraw()}>
												{pendingActionLabel(actions, "withdraw")}
											</button>
										))
									: undefined
							}
						>
							Refunds are pushed to your wallet automatically. If a push cannot be delivered, the
							ETH is credited to a pull ledger instead and waits here. Withdrawing is always
							available and needs nothing from the team.
						</Tool>

						<Tool
							title="Settle the auction yourself"
							status={
								finalizeOpen
									? "available"
									: s.phase === "settled"
										? "done"
										: s.supplyMismatched || s.mintingUnavailable
											? "inactive"
											: "scheduled"
							}
							note={
								s.phase === "settled"
									? "settled"
									: s.supplyMismatched
										? "supply recovery required"
										: s.mintingUnavailable
											? "minting recovery required"
									: finalizeOpen
										? "open to anyone"
										: s.finalizeEligibleAt > 0
											? `opens ${fmtDateUTC(s.finalizeEligibleAt)}`
											: "after the sale ends"
							}
							action={
								finalizeOpen
									? (connectGate ?? (
											<>
												<button
													className={GHOST}
													disabled={writeBlocked}
													onClick={() => actions.finalize(BATCH)}
												>
													{pendingActionLabel(actions, `settle next ${BATCH}`)}
												</button>
												{etherscanFallback}
											</>
										))
									: undefined
							}
						>
							Settlement mints the winners and refunds every excess. The owner can run it from the
							moment the sale ends. Seven days after the end, finalize opens to every wallet, so
							the sale settles even if the team never shows up. Repeat the call until the phase
							reads settled.
						</Tool>

						<Tool
							title="Refunds after a cancellation"
							status={
								cancelledRefunds ? "available" : s.phase === "cancelled" ? "done" : "inactive"
							}
							note={
								cancelledRefunds
									? s.activeBids > 0
										? `${s.activeBids} refunds remaining`
										: "one final call remaining"
									: s.phase === "cancelled"
										? "refunds complete"
										: "auction is not cancelled"
							}
							action={
								cancelledRefunds
									? (connectGate ?? (
											<>
												<button
													className={GHOST}
													disabled={writeBlocked}
													onClick={() => actions.refundAll(BATCH)}
												>
													{busy
														? pendingActionLabel(actions, "")
														: s.activeBids > 0
															? `refund next ${BATCH}`
															: "finish recovery"}
												</button>
												{etherscanFallback}
											</>
										))
									: undefined
							}
						>
							If the owner cancels the sale, every bid is refunded in full. The refund calls are
							open to any wallet immediately. The last call also releases any accounting that
							remains, so keep calling until refunds read complete.
						</Tool>

						<Tool
							title="Supply mismatch recovery"
							status={mismatchOpen ? "available" : "inactive"}
							note={mismatchOpen ? "mismatch detected" : "supply is as expected"}
							action={
								mismatchOpen
									? (connectGate ?? (
											<>
												<button
													className={GHOST}
													disabled={writeBlocked}
													onClick={() => actions.recoverFromSupplyMismatch(BATCH)}
												>
													{pendingActionLabel(actions, "start recovery")}
												</button>
												{etherscanFallback}
											</>
										))
									: undefined
							}
						>
							The auction checks the collection supply before every action. If another mint ever
							consumes a token the auction expected, bidding and settlement halt and any wallet
							can immediately convert the sale into full refunds.
						</Tool>

						<Tool
							title="Minting capability recovery"
							status={
								mintingUnavailableOpen
									? "available"
									: mismatchOpen
										? "inactive"
										: s.phase === "settled" || s.phase === "cancelled"
											? "done"
											: "scheduled"
							}
							note={
								mismatchOpen
									? "use supply mismatch recovery first"
									: mintingUnavailableOpen
										? "open to anyone"
										: s.mintingUnavailable
											? s.finalizeEligibleAt > 0
												? `opens ${fmtDateUTC(s.finalizeEligibleAt)}`
												: "after the seven-day grace period"
											: "minting is available"
							}
							action={
								mintingUnavailableOpen
									? (connectGate ?? (
										<>
											<button
												className={GHOST}
												disabled={writeBlocked}
												onClick={() => actions.recoverFromMintingUnavailable(BATCH)}
											>
												{pendingActionLabel(actions, "start recovery")}
											</button>
											{etherscanFallback}
										</>
									))
									: undefined
							}
						>
							If the collection has not authorized the auction to mint, or its mint cap is
							below the amount needed to settle every bid, any wallet can start full refunds
							after the seven-day settlement grace period. A supply mismatch takes priority
							when both conditions exist.
						</Tool>

						<Tool
							title="Emergency refund"
							status={emergencyOpen ? "available" : settledOrRecovered ? "done" : "scheduled"}
							note={
								settledOrRecovered
									? "not needed"
									: emergencyOpen
										? "open to anyone"
										: s.emergencyEligibleAt > 0
											? `opens ${fmtDateUTC(s.emergencyEligibleAt)}`
											: "30 days after the hard deadline"
							}
							action={
								emergencyOpen
									? (connectGate ?? (
											<>
												<button
													className={GHOST}
													disabled={writeBlocked}
													onClick={() => actions.emergencyRefund(BATCH)}
												>
													{pendingActionLabel(actions, `emergency refund ${BATCH}`)}
												</button>
												{etherscanFallback}
											</>
										))
									: undefined
							}
						>
							The last resort. Thirty days after the hard deadline, if the sale is still not
							settled, any wallet can refund every unminted bid in full. It works even if the
							auction was never authorized to mint and even if settlement stopped halfway.
						</Tool>
						</ol>
						</>
					)}

				{lastTx && (
					<a
						href={getBlockExplorerTxUrl(lastTx)}
						target="_blank"
						rel="noreferrer"
						className="inline-block mt-8 font-mono text-micro uppercase tracking-[0.18em] text-muted hover:text-foreground transition-colors"
					>
						view transaction ↗
					</a>
				)}
			</main>
		</div>
	);
}

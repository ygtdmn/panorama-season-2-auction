"use client";

import { useEffect, useState } from "react";
import type { AuctionActions } from "@/app/auction/hooks/useAuctionActions";
import { getBlockExplorerTxUrl } from "@/lib/constants";

// The automatic probes settle a dropped or replaced transaction within about a minute. The
// manual release only appears past that, for an RPC that can neither produce a receipt nor
// admit the transaction is gone, and it always takes a second, explicit confirmation.
const MANUAL_RELEASE_AFTER_MS = 90_000;

export function pendingActionLabel(
	actions: AuctionActions,
	idle: string,
	/** Reads are degraded or stale, so the button is disabled. Say so instead of looking dead. */
	resyncing?: boolean,
): string {
	if (!actions.trackerReady) return "checking wallet activity…";
	if (actions.status === "signing") return "confirm in wallet…";
	if (actions.status === "pending") return "transaction pending…";
	if (actions.status === "unknown") return "status unknown / still tracking";
	if (resyncing) return "reconnecting to the network…";
	return idle;
}

/** Persistent status for a submitted transaction. Unknown is deliberately not an error/idle state. */
export function TransactionStatus({ actions }: { actions: AuctionActions }) {
	const [confirmingRelease, setConfirmingRelease] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const unknown = actions.status === "unknown";

	useEffect(() => {
		if (!unknown) {
			setConfirmingRelease(false);
			return;
		}
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 5_000);
		return () => window.clearInterval(timer);
	}, [unknown, actions.txHash]);

	if (!actions.txHash || (actions.status !== "pending" && !unknown)) {
		return null;
	}

	const releasable =
		unknown && now - (actions.submittedAt ?? now) >= MANUAL_RELEASE_AFTER_MS;
	const replaced =
		!!actions.originalTxHash && actions.originalTxHash.toLowerCase() !== actions.txHash.toLowerCase();

	return (
		<div
			className={`border p-3 flex flex-col gap-2 ${
				actions.status === "unknown" ? "border-signal/50" : "border-line"
			}`}
			role="status"
			aria-live="polite"
		>
			<span className="font-mono text-micro uppercase tracking-[0.14em] text-foreground">
				{actions.status === "unknown" ? "Receipt not confirmed yet" : "Transaction submitted"}
			</span>
			<p className="font-sans text-xs text-muted leading-relaxed">
				{unknown
					? "No receipt yet. The action stays locked so you cannot bid twice, and this page keeps checking both for a receipt and for whether the transaction is still on the network. If it was dropped or replaced, the form unlocks by itself. Check your wallet and the explorer meanwhile."
					: actions.replacementReason === "repriced"
						? "A fee-only replacement was detected. Tracking the replacement until it confirms."
						: "Waiting for an on-chain receipt. Do not submit the action again."}
			</p>
			<div className="flex flex-wrap gap-x-4 gap-y-1">
				<a
					href={getBlockExplorerTxUrl(actions.txHash)}
					target="_blank"
					rel="noreferrer"
					className="font-mono text-micro uppercase tracking-[0.14em] text-foreground underline hover:opacity-60"
				>
					{replaced ? "replacement transaction ↗" : "view transaction ↗"}
				</a>
				{replaced && actions.originalTxHash && (
					<a
						href={getBlockExplorerTxUrl(actions.originalTxHash)}
						target="_blank"
						rel="noreferrer"
						className="font-mono text-micro uppercase tracking-[0.14em] text-muted underline hover:text-foreground"
					>
						original transaction ↗
					</a>
				)}
			</div>
			{releasable &&
				(confirmingRelease ? (
					<div className="flex flex-col gap-2 border-t border-line pt-2">
						<p className="font-sans text-xs text-muted leading-relaxed">
							Only release this if the explorer shows the transaction failed, was replaced, or
							does not exist. If it did go through, bidding again creates a second, separate bid.
						</p>
						<div className="flex flex-wrap gap-x-4 gap-y-1">
							<button
								type="button"
								onClick={actions.forceUnlock}
								className="font-mono text-micro uppercase tracking-[0.14em] text-signal underline hover:opacity-60"
							>
								confirm release
							</button>
							<button
								type="button"
								onClick={() => setConfirmingRelease(false)}
								className="font-mono text-micro uppercase tracking-[0.14em] text-muted underline hover:text-foreground"
							>
								keep tracking
							</button>
						</div>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setConfirmingRelease(true)}
						className="self-start font-mono text-micro uppercase tracking-[0.14em] text-muted underline hover:text-foreground"
					>
						release the lock
					</button>
				))}
		</div>
	);
}

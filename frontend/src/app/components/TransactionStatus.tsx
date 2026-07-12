"use client";

import type { AuctionActions } from "@/app/auction/hooks/useAuctionActions";
import { getBlockExplorerTxUrl } from "@/lib/constants";

export function pendingActionLabel(actions: AuctionActions, idle: string): string {
	if (!actions.trackerReady) return "checking wallet activity…";
	if (actions.status === "signing") return "confirm in wallet…";
	if (actions.status === "pending") return "transaction pending…";
	if (actions.status === "unknown") return "status unknown / still tracking";
	return idle;
}

/** Persistent status for a submitted transaction. Unknown is deliberately not an error/idle state. */
export function TransactionStatus({ actions }: { actions: AuctionActions }) {
	if (!actions.txHash || (actions.status !== "pending" && actions.status !== "unknown")) {
		return null;
	}

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
				{actions.status === "unknown"
					? "The RPC has not produced a terminal receipt. The action remains locked to prevent a duplicate bid or raise; check your wallet and the explorer while this page keeps tracking it."
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
		</div>
	);
}

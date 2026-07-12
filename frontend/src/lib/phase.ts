import type { AuctionPhase } from "@/app/auction/hooks/useAuctionState";

/**
 * The contract reports "active" from deployment until finalize/cancel, which spans
 * three very different moments for a visitor: waiting for the start, live bidding,
 * and bidding closed awaiting settlement.
 */
export type DisplayPhase = AuctionPhase | "upcoming" | "closed";

/**
 * Split the contract's "active" span into upcoming / live / closed using the
 * chain-anchored clock. Falls back to the raw phase until the clock (now=0) or
 * the schedule (startTime/endTime=0) is known, so nothing flips on first paint.
 */
export function displayPhase(
	phase: AuctionPhase,
	now: number,
	startTime: number,
	endTime: number,
): DisplayPhase {
	if (phase !== "active" || now === 0) return phase;
	if (startTime > 0 && now < startTime) return "upcoming";
	if (endTime > 0 && now >= endTime) return "closed";
	return phase;
}

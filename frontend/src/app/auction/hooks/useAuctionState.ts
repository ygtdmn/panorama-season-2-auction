"use client";

import { useAccount, useBlock, usePublicClient, useReadContracts } from "wagmi";
import { getAbiItem, isAddressEqual } from "viem";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { panoramaAuctionAbi } from "@/lib/abis/panoramaAuction";
import {
	AUCTION_DEPLOY_BLOCK,
	PANORAMA_AUCTION_ADDRESS,
} from "@/lib/constants";
import type { ChainTimeAnchor } from "../components/ui";
import { assessWonLogIntegrity } from "@/lib/wonLogIntegrity";

export type AuctionPhase = "active" | "finalizing" | "settled" | "cancelled";

const PHASES: AuctionPhase[] = ["active", "finalizing", "settled", "cancelled"];

/** Poll cadence: relaxed normally, tight inside the anti-snipe endgame. */
const NEAR_END_WINDOW_S = 15 * 60;
const NEAR_END_POLL_MS = 3_000;
const SNAPSHOT_STALE_MS = 45_000;

export type WonLogStatus = "not-needed" | "loading" | "ready" | "degraded" | "error";

export interface YourBid {
	id: number;
	amount: bigint;
}

export interface AuctionBidRow {
	id: number;
	bidder: `0x${string}`;
	amount: bigint;
}

/** A minted winner, reconstructed from Won events so standings survive settlement. */
export interface WonRow {
	id: number;
	bidder: `0x${string}`;
	amount: bigint; // original bid
	tokenId: number;
	pricePaid: bigint;
}

export interface AuctionState {
	/** True once a full consistent snapshot has EVER loaded (data persists across failed refetches). */
	ready: boolean;
	/** First load still in flight. */
	isLoading: boolean;
	/** No snapshot could be loaded at all: show an error surface, never zero-defaults. */
	readFailed: boolean;
	/** A snapshot exists but the latest refetch failed: data may be stale, actions should warn. */
	degraded: boolean;
	/** No successful full snapshot within the safety window. All writes must stay disabled. */
	stale: boolean;
	/** Connected-account reads are part of the action-safety snapshot. */
	accountReady: boolean;
	accountReadFailed: boolean;
	refetch: () => void;

	/** Latest block time anchor for chain-clock derivation (undefined until the first block). */
	chainTime?: ChainTimeAnchor;

	phase: AuctionPhase;
	paused: boolean;
	startTime: number; // unix seconds
	endTime: number; // unix seconds
	absoluteEndTime: number; // immutable extension ceiling
	scheduledEndTime: number; // configured end before any extension (absoluteEnd - MAX_TOTAL_EXTENSION)
	reservePrice: bigint;
	minIncrementBps: number;
	extensionCount: number;
	maxUnits: number;
	maxBidsPerWallet: number;

	activeBids: number;
	isFull: boolean;
	currentClearingPrice: bigint; // price a winner pays if it ended now
	lowestActiveBid: bigint; // heap root
	minimumBid: bigint; // min value a new bid must send now
	minIncreaseForExtension: bigint;
	clearingPrice: bigint; // frozen at finalize (0 until then)
	proceeds: bigint;
	finalizeCursor: number;
	refundCursor: number;
	winnerCount: number;
	refundsComplete: boolean;
	totalEscrowed: bigint;
	totalPendingReturns: bigint;
	unreleasedProceeds: bigint;
	totalLiabilities: bigint;
	surplusEth: bigint;
	/** Anyone may call finalize from this time (endTime + FINALIZE_GRACE). */
	finalizeEligibleAt: number;
	/** Anyone may call emergencyRefund from this time (absoluteEndTime + EMERGENCY_GRACE). */
	emergencyEligibleAt: number;
	expectedNftSupply: number;
	supplyMismatched: boolean;
	requiredMintCapForSettlement: bigint;
	mintingUnavailable: boolean;
	firstTokenId: number;
	lastTokenId: number;

	owner?: `0x${string}`;
	payoutA?: `0x${string}`;
	payoutB?: `0x${string}`;

	// full live board (sorted high -> low)
	allBids: AuctionBidRow[];
	// minted winners from Won events (sorted by tokenId): populated once settlement starts
	wonBids: WonRow[];
	wonStatus: WonLogStatus;
	wonExpectedCount: number;
	wonIntegrityIssue?: string;
	refetchWon: () => void;

	// connected account
	isOwner: boolean;
	yourBidCount: number;
	yourBids: YourBid[];
	yourPending: bigint;
}

const base = {
	address: PANORAMA_AUCTION_ADDRESS,
	abi: panoramaAuctionAbi,
} as const;

const wonEvent = getAbiItem({ abi: panoramaAuctionAbi, name: "Won" });

export function useAuctionState(pollMs = 12_000): AuctionState {
	const { address } = useAccount();
	const enabled = !!PANORAMA_AUCTION_ADDRESS;
	const publicClient = usePublicClient();

	// ---- chain clock: watch blocks; the block timestamp is the authoritative "now" ----------
	const [chainTime, setChainTime] = useState<ChainTimeAnchor>();
	const block = useBlock({
		watch: enabled ? { pollingInterval: 4_000 } : false,
		query: { enabled },
	});
	const blockNumber = block.data?.number;
	const blockTimestamp = block.data?.timestamp;
	useEffect(() => {
		if (blockTimestamp === undefined) return;
		setChainTime({ timestamp: Number(blockTimestamp), atMs: Date.now() });
	}, [blockNumber, blockTimestamp]);

	// ---- reads: fail closed. allowFailure:false means one bad call fails the whole snapshot
	// instead of quietly zero-filling minimumBid/phase/endTime. -------------------------------
	const global = useReadContracts({
		allowFailure: false,
		contracts: [
			{ ...base, functionName: "phase" }, // 0
			{ ...base, functionName: "paused" }, // 1
			{ ...base, functionName: "startTime" }, // 2
			{ ...base, functionName: "endTime" }, // 3
			{ ...base, functionName: "reservePrice" }, // 4
			{ ...base, functionName: "minIncrementBps" }, // 5
			{ ...base, functionName: "extensionCount" }, // 6
			{ ...base, functionName: "MAX_UNITS" }, // 7
			{ ...base, functionName: "MAX_BIDS_PER_WALLET" }, // 8
			{ ...base, functionName: "activeBids" }, // 9
			{ ...base, functionName: "isFull" }, // 10
			{ ...base, functionName: "currentClearingPrice" }, // 11
			{ ...base, functionName: "lowestActiveBid" }, // 12
			{ ...base, functionName: "minimumBid" }, // 13
			{ ...base, functionName: "clearingPrice" }, // 14
			{ ...base, functionName: "proceeds" }, // 15
			{ ...base, functionName: "owner" }, // 16
			{ ...base, functionName: "payoutA" }, // 17
			{ ...base, functionName: "payoutB" }, // 18
			{ ...base, functionName: "getBids" }, // 19
			{ ...base, functionName: "absoluteEndTime" }, // 20
			{ ...base, functionName: "finalizeCursor" }, // 21
			{ ...base, functionName: "refundCursor" }, // 22
			{ ...base, functionName: "winnerCount" }, // 23
			{ ...base, functionName: "refundsComplete" }, // 24
			{ ...base, functionName: "totalEscrowed" }, // 25
			{ ...base, functionName: "totalPendingReturns" }, // 26
			{ ...base, functionName: "unreleasedProceeds" }, // 27
			{ ...base, functionName: "totalLiabilities" }, // 28
			{ ...base, functionName: "surplusETH" }, // 29
			{ ...base, functionName: "EMERGENCY_GRACE" }, // 30
			{ ...base, functionName: "FIRST_TOKEN_ID" }, // 31
			{ ...base, functionName: "LAST_TOKEN_ID" }, // 32
			{ ...base, functionName: "minIncreaseForExtension" }, // 33
			{ ...base, functionName: "expectedNftSupply" }, // 34
			{ ...base, functionName: "supplyMismatched" }, // 35
				{ ...base, functionName: "FINALIZE_GRACE" }, // 36
				{ ...base, functionName: "MAX_TOTAL_EXTENSION" }, // 37
				{ ...base, functionName: "requiredMintCapForSettlement" }, // 38
				{ ...base, functionName: "mintingUnavailable" }, // 39
			],
		query: { enabled, refetchInterval: pollMs },
	});
	const g = global.data as readonly unknown[] | undefined;

	const phase: AuctionPhase = PHASES[Number(g?.[0] ?? 0)] ?? "active";
	const endTime = Number((g?.[3] as bigint) ?? 0n);

	// Tight polling inside the endgame: extensions land block by block and the UI must follow.
	const chainNowApprox = chainTime?.timestamp ?? 0;
	const nearEnd =
		phase === "active" &&
		endTime > 0 &&
		chainNowApprox > 0 &&
		endTime - chainNowApprox < NEAR_END_WINDOW_S;
	const effectivePollMs = nearEnd ? NEAR_END_POLL_MS : pollMs;

	const account = useReadContracts({
		allowFailure: false,
		contracts: address
			? [
					{ ...base, functionName: "activeBidCount", args: [address] },
					{ ...base, functionName: "pendingReturns", args: [address] },
					{ ...base, functionName: "bidsOf", args: [address] },
				]
			: [],
		query: { enabled: enabled && !!address, refetchInterval: effectivePollMs },
	});
	const a = account.data as readonly unknown[] | undefined;
	const [healthNow, setHealthNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) return;
		const timer = window.setInterval(() => setHealthNow(Date.now()), 5_000);
		return () => window.clearInterval(timer);
	}, [enabled]);
	const globalReady = g !== undefined;
	const accountReady = !address || a !== undefined;
	const globalStale = globalReady && healthNow - global.dataUpdatedAt > SNAPSHOT_STALE_MS;
	const accountStale =
		!!address && accountReady && healthNow - account.dataUpdatedAt > SNAPSHOT_STALE_MS;
	const blockStale = !!chainTime && healthNow - chainTime.atMs > SNAPSHOT_STALE_MS;

	// Re-read on every new block: on-chain state only changes with blocks, so this both caps
	// staleness at one block and avoids blind trust in the device clock or a fixed interval.
	const refetchRef = useRef<() => void>(() => {});
	useEffect(() => {
		refetchRef.current = () => {
			// Refetch the block too: a stalled block-watch is the usual cause of a stuck snapshot,
			// and refreshing the anchor is what lets the clock and per-block refetch recover.
			block.refetch();
			global.refetch();
			if (address) account.refetch();
		};
	});
	useEffect(() => {
		if (blockNumber !== undefined) refetchRef.current();
	}, [blockNumber]);

	// Keep the tight cadence applied to the global query as well (react-query picks up the
	// changed refetchInterval through re-render; this mirrors `account` above).
	useEffect(() => {
		if (!nearEnd) return;
		const t = setInterval(() => refetchRef.current(), NEAR_END_POLL_MS);
		return () => clearInterval(t);
	}, [nearEnd]);

	// Self-heal: the moment a snapshot looks stale (the health tick re-checks every 5s), force a
	// full refetch instead of surfacing a scary banner. This is what keeps the data from getting
	// stuck when the block-watch or a poll transiently stalls.
	useEffect(() => {
		if (!enabled) return;
		if (globalStale || accountStale || blockStale) refetchRef.current();
	}, [enabled, globalStale, accountStale, blockStale, healthNow]);

	const owner = g?.[16] as `0x${string}` | undefined;
	const isOwner = !!(address && owner && isAddressEqual(address, owner));

	const finalizeCursor = Number((g?.[21] as bigint) ?? 0n);
	const winnerCount = Number((g?.[23] as bigint) ?? 0n);
	const firstTokenId = Number((g?.[31] as bigint) ?? 91n);

	// ---- minted winners from events: standings survive settlement and persist afterwards ----
	const wonLogsEnabled =
		enabled && !!publicClient && (phase !== "active" || finalizeCursor > 0);
	const wonQuery = useQuery({
		queryKey: [
			"auction-won-logs",
			PANORAMA_AUCTION_ADDRESS,
			AUCTION_DEPLOY_BLOCK.toString(),
			phase,
			finalizeCursor,
		],
		enabled: wonLogsEnabled,
		staleTime: phase === "settled" ? Infinity : 10_000,
		placeholderData: (previous) => previous,
		retry: 2,
		queryFn: async () => {
			const logs = await publicClient!.getLogs({
				address: PANORAMA_AUCTION_ADDRESS,
				event: wonEvent,
				fromBlock: AUCTION_DEPLOY_BLOCK,
				toBlock: "latest",
				strict: true,
			});
			return logs.map((l) => ({
				id: Number(l.args.bidId),
				bidder: l.args.winner as `0x${string}`,
				amount: l.args.bidAmount as bigint,
				tokenId: Number(l.args.tokenId),
				pricePaid: l.args.pricePaid as bigint,
			}));
		},
	});
	const rawWonBids = useMemo<WonRow[]>(() => {
		if (!wonQuery.data) return [];
		return [...wonQuery.data].sort((x, y) => x.tokenId - y.tokenId);
	}, [wonQuery.data]);
	const wonIntegrity = useMemo(
		() =>
			assessWonLogIntegrity({
				phase,
				finalizeCursor,
				winnerCount,
				firstTokenId,
				tokenIds: rawWonBids.map((row) => row.tokenId),
			}),
		[phase, finalizeCursor, winnerCount, firstTokenId, rawWonBids],
	);
	const wonStatus: WonLogStatus = !wonLogsEnabled
		? "not-needed"
		: wonQuery.isPending
			? "loading"
			: wonQuery.isError && !wonQuery.data
				? "error"
				: wonQuery.isError || !wonIntegrity.valid
					? "degraded"
					: "ready";
	const refetchWonQuery = wonQuery.refetch;
	// Providers can expose the state-changing block before its logs endpoint catches up. Keep
	// retrying a successful-but-incomplete scan; never turn the gap into a false empty board.
	useEffect(() => {
		if (!wonLogsEnabled || wonQuery.isPending || wonIntegrity.valid) return;
		const timer = window.setTimeout(() => void refetchWonQuery(), 3_000);
		return () => window.clearTimeout(timer);
	}, [wonLogsEnabled, wonQuery.isPending, wonIntegrity.valid, refetchWonQuery]);
	// A sequential prefix is useful while the logs endpoint catches up. Never render rows when
	// ordering is invalid or the provider returned more events than the on-chain cursor permits.
	const wonBids =
		wonIntegrity.issue?.includes("not sequential") || rawWonBids.length > finalizeCursor
			? []
			: rawWonBids;

	const yourBids = useMemo<YourBid[]>(() => {
		const res = a?.[2] as
			| readonly [readonly number[], readonly bigint[]]
			| undefined;
		if (!res) return [];
		const [ids, amounts] = res;
		return ids.map((id, i) => ({ id, amount: amounts[i] }));
	}, [a]);

	const allBids = useMemo<AuctionBidRow[]>(() => {
		const res = g?.[19] as
			| readonly [
					readonly number[],
					readonly `0x${string}`[],
					readonly bigint[],
				]
			| undefined;
		if (!res) return [];
		const [ids, bidders, amounts] = res;
		return ids
			.map((id, i) => ({ id, bidder: bidders[i], amount: amounts[i] }))
			.sort((x, y) =>
				x.amount < y.amount ? 1 : x.amount > y.amount ? -1 : x.id - y.id,
			);
	}, [g]);

	const absoluteEndTime = Number((g?.[20] as bigint) ?? 0n);
	const maxTotalExtension = Number((g?.[37] as bigint) ?? 86_400n);

	return {
		ready: enabled && globalReady && accountReady,
		isLoading:
			global.isPending || (!!address && account.isPending && a === undefined),
		readFailed:
			enabled &&
			((global.isError && !globalReady) || (!!address && account.isError && !accountReady)),
		degraded:
			enabled &&
			globalReady &&
			(global.isError || (!!address && account.isError)),
		stale:
			enabled &&
			globalReady &&
			accountReady &&
			(globalStale || accountStale || blockStale),
		accountReady,
		accountReadFailed: !!address && account.isError && !accountReady,
		refetch: () => refetchRef.current(),

		chainTime,

		phase,
		paused: Boolean(g?.[1]),
		startTime: Number((g?.[2] as bigint) ?? 0n),
		endTime,
		absoluteEndTime,
		scheduledEndTime: absoluteEndTime > 0 ? absoluteEndTime - maxTotalExtension : 0,
		reservePrice: (g?.[4] as bigint) ?? 0n,
		minIncrementBps: Number(g?.[5] ?? 0),
		extensionCount: Number(g?.[6] ?? 0),
		maxUnits: Number((g?.[7] as bigint) ?? 90n),
		maxBidsPerWallet: Number(g?.[8] ?? 4),

		activeBids: Number((g?.[9] as bigint) ?? 0n),
		isFull: Boolean(g?.[10]),
		currentClearingPrice: (g?.[11] as bigint) ?? 0n,
		lowestActiveBid: (g?.[12] as bigint) ?? 0n,
		minimumBid: (g?.[13] as bigint) ?? 0n,
		minIncreaseForExtension: (g?.[33] as bigint) ?? 0n,
		clearingPrice: (g?.[14] as bigint) ?? 0n,
		proceeds: (g?.[15] as bigint) ?? 0n,
		finalizeCursor,
		refundCursor: Number((g?.[22] as bigint) ?? 0n),
		winnerCount,
		refundsComplete: Boolean(g?.[24]),
		totalEscrowed: (g?.[25] as bigint) ?? 0n,
		totalPendingReturns: (g?.[26] as bigint) ?? 0n,
		unreleasedProceeds: (g?.[27] as bigint) ?? 0n,
		totalLiabilities: (g?.[28] as bigint) ?? 0n,
		surplusEth: (g?.[29] as bigint) ?? 0n,
		finalizeEligibleAt: endTime + Number((g?.[36] as bigint) ?? 0n),
		emergencyEligibleAt: absoluteEndTime + Number((g?.[30] as bigint) ?? 0n),
		expectedNftSupply: Number((g?.[34] as bigint) ?? 90n),
		supplyMismatched: Boolean(g?.[35]),
		requiredMintCapForSettlement: (g?.[38] as bigint) ?? 0n,
		mintingUnavailable: Boolean(g?.[39]),
		firstTokenId,
		lastTokenId: Number((g?.[32] as bigint) ?? 180n),

		owner,
		payoutA: g?.[17] as `0x${string}` | undefined,
		payoutB: g?.[18] as `0x${string}` | undefined,

		allBids,
		wonBids,
		wonStatus,
		wonExpectedCount: wonIntegrity.expected,
		wonIntegrityIssue: wonIntegrity.issue ?? undefined,
		refetchWon: () => void refetchWonQuery(),

		isOwner,
		yourBidCount: Number(a?.[0] ?? 0),
		yourBids,
		yourPending: (a?.[1] as bigint) ?? 0n,
	};
}

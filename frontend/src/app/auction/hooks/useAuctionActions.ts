"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import type { Hash, TransactionReceipt } from "viem";
import { TARGET_CHAIN } from "@/lib/wagmi";
import { panoramaAuctionAbi } from "@/lib/abis/panoramaAuction";
import { PANORAMA_AUCTION_ADDRESS } from "@/lib/constants";
import {
	emptyTransactionTracker,
	hydratePersistedTransaction,
	isTransactionUnresolved,
	persistableTransaction,
	transactionTrackerReducer,
	type ReplacementReason,
	type TransactionStatus,
} from "@/lib/auctionTransaction";

export type ActionStatus = TransactionStatus;

export type WriteName =
	| "placeBid"
	| "increaseBid"
	| "withdraw"
	| "finalize"
	| "cancelAuction"
	| "refundAll"
	| "emergencyRefund"
	| "recoverFromSupplyMismatch"
	| "recoverFromMintingUnavailable"
	| "setPaused";

export interface AuctionActions {
	status: ActionStatus;
	/** The action currently in flight, or the last one that finished. */
	lastAction?: WriteName;
	/** Effective hash (the replacement hash after a speed-up/replacement). */
	txHash?: Hash;
	/** Hash first returned by the wallet. Never changes. */
	originalTxHash?: Hash;
	replacementHash?: Hash;
	replacementReason?: ReplacementReason;
	error: Error | null;
	/** True for signing, mined-status pending, and indeterminate receipt state. */
	unresolved: boolean;
	/** False only during the one-time local pending-transaction restore. */
	trackerReady: boolean;
	wrongChain: boolean;
	switching: boolean;
	switchToTargetChain: () => void;
	/** Clears terminal state only. It intentionally cannot clear an unresolved transaction. */
	reset: () => void;

	placeBid: (valueWei: bigint) => void;
	increaseBid: (bidId: number, addWei: bigint) => void;
	withdraw: () => void;
	finalize: (batch: number) => void;
	cancelAuction: () => void;
	refundAll: (batch: number) => void;
	emergencyRefund: (batch: number) => void;
	recoverFromSupplyMismatch: (batch: number) => void;
	recoverFromMintingUnavailable: (batch: number) => void;
	setPaused: (paused: boolean) => void;
}

const RECEIPT_UNKNOWN_AFTER_MS = 60_000;
const RECEIPT_WAIT_SLICE_MS = 30_000;
const RECEIPT_RETRY_DELAY_MS = 3_000;
const PENDING_STORAGE_KEY = `panorama-auction:pending:${TARGET_CHAIN.id}:${PANORAMA_AUCTION_ADDRESS.toLowerCase()}`;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function revertedError(): Error {
	return new Error(
		"Transaction reverted on-chain. Auction state may have changed before it was mined; refresh and try again.",
	);
}

/**
 * One in-flight write at a time. Writes are simulated before the wallet opens. Once a wallet
 * returns a hash, neither a 60-second timeout nor a transient RPC error unlocks the form: the
 * action moves to `unknown`, remains persisted across reloads, and keeps reconciling until a
 * mined original/repriced/cancel/replacement receipt proves the terminal outcome.
 */
export function useAuctionActions(onSuccess?: () => void): AuctionActions {
	const { address, chainId } = useAccount();
	const { switchChain, isPending: switching } = useSwitchChain();
	const publicClient = usePublicClient();
	const writer = useWriteContract();
	const [tracker, dispatch] = useReducer(
		transactionTrackerReducer<WriteName>,
		undefined,
		emptyTransactionTracker<WriteName>,
	);
	// React state updates after an event returns. This imperative lock closes the tiny double-click
	// window before the `signing` render lands; reducer state remains the durable source of truth.
	const writeLockRef = useRef(false);
	const [trackerReady, setTrackerReady] = useState(false);
	const notifiedHashRef = useRef<Hash | undefined>(undefined);

	const wrongChain = chainId !== TARGET_CHAIN.id;
	const unresolved = !trackerReady || isTransactionUnresolved(tracker.status);

	// Restore an unresolved transaction before enabling any write. A reload must not create a
	// duplicate bid merely because React forgot the receipt query.
	useEffect(() => {
		try {
			const raw = window.localStorage.getItem(PENDING_STORAGE_KEY);
			if (raw) {
				const restored = hydratePersistedTransaction<WriteName>(JSON.parse(raw));
				if (restored) dispatch({ type: "hydrate", tracker: restored });
				else window.localStorage.removeItem(PENDING_STORAGE_KEY);
			}
		} catch {
			// Storage may be unavailable in hardened/private contexts. In-memory tracking still works.
		}
		setTrackerReady(true);
	}, []);

	useEffect(() => {
		if (!trackerReady) return;
		try {
			const persisted = persistableTransaction(tracker);
			if (persisted) {
				window.localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(persisted));
			} else {
				window.localStorage.removeItem(PENDING_STORAGE_KEY);
			}
		} catch {
			// See storage note above.
		}
	}, [tracker, trackerReady]);

	useEffect(() => {
		writeLockRef.current = isTransactionUnresolved(tracker.status);
	}, [tracker.status]);

	// Receipt reconciliation deliberately uses viem directly. Wagmi's wrapper turns a finite
	// timeout into a terminal query error; here timeouts are only an observability state.
	useEffect(() => {
		if (!trackerReady || !publicClient || !tracker.originalHash) return;
		if (!isTransactionUnresolved(tracker.status)) return;

		let stopped = false;
		let currentHash = tracker.currentHash ?? tracker.originalHash;
		const submittedAt = tracker.submittedAt ?? Date.now();
		const unknownTimer = window.setTimeout(
			() => dispatch({ type: "delayed" }),
			Math.max(0, RECEIPT_UNKNOWN_AFTER_MS - (Date.now() - submittedAt)),
		);

		const finishFromReceipt = (receipt: TransactionReceipt) => {
			window.clearTimeout(unknownTimer);
			writeLockRef.current = false;
			dispatch({
				type: "receipt",
				receiptStatus: receipt.status,
				error: receipt.status === "reverted" ? revertedError() : undefined,
			});
		};

		const reconcile = async () => {
			while (!stopped) {
				try {
					const receipt = await publicClient.waitForTransactionReceipt({
						hash: tracker.originalHash!,
						timeout: RECEIPT_WAIT_SLICE_MS,
						onReplaced: (replacement) => {
							currentHash = replacement.transaction.hash;
							dispatch({
								type: "replacement",
								hash: replacement.transaction.hash,
								reason: replacement.reason,
							});
						},
					});
					if (!stopped) finishFromReceipt(receipt);
					return;
				} catch (error) {
					if (stopped) return;

					// A transport timeout may race a mined effective hash. Check it directly before
					// declaring the status indeterminate.
					try {
						const receipt = await publicClient.getTransactionReceipt({ hash: currentHash });
						if (!stopped) finishFromReceipt(receipt);
						return;
					} catch {
						// No terminal receipt visible on this RPC yet.
					}

					if (Date.now() - submittedAt >= RECEIPT_UNKNOWN_AFTER_MS) {
						dispatch({ type: "wait-error", error: error as Error });
					}
					await sleep(RECEIPT_RETRY_DELAY_MS);
				}
			}
		};

		void reconcile();
		return () => {
			stopped = true;
			window.clearTimeout(unknownTimer);
		};
	}, [
		publicClient,
		tracker.currentHash,
		tracker.originalHash,
		tracker.replacementReason,
		tracker.status,
		tracker.submittedAt,
		trackerReady,
	]);

	useEffect(() => {
		if (tracker.status !== "success" || !tracker.currentHash) return;
		if (notifiedHashRef.current === tracker.currentHash) return;
		notifiedHashRef.current = tracker.currentHash;
		onSuccess?.();
	}, [tracker.status, tracker.currentHash, onSuccess]);

	const switchToTargetChain = useCallback(() => {
		switchChain({ chainId: TARGET_CHAIN.id });
	}, [switchChain]);

	const reset = useCallback(() => {
		if (isTransactionUnresolved(tracker.status)) return;
		writer.reset();
		dispatch({ type: "reset" });
	}, [tracker.status, writer]);

	const send = useCallback(
		async (functionName: WriteName, args: unknown[], value?: bigint) => {
			if (
				!trackerReady ||
				writeLockRef.current ||
				isTransactionUnresolved(tracker.status)
			) return;
			if (!address) return;
			if (wrongChain) {
				switchToTargetChain();
				return;
			}

			writeLockRef.current = true;
			dispatch({ type: "begin", action: functionName, account: address });
			const params = {
				account: address,
				chainId: TARGET_CHAIN.id,
				address: PANORAMA_AUCTION_ADDRESS,
				abi: panoramaAuctionAbi,
				functionName,
				args,
				...(value !== undefined ? { value } : {}),
			};

			try {
				if (!publicClient) throw new Error("RPC client is not ready. Try again in a moment.");
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				await publicClient.simulateContract(params as any);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const hash = await writer.writeContractAsync(params as any);
				dispatch({ type: "submitted", hash, submittedAt: Date.now() });
			} catch (error) {
				writeLockRef.current = false;
				dispatch({ type: "preflight-error", error: error as Error });
			}
		},
		[
			trackerReady,
			tracker.status,
			address,
			wrongChain,
			switchToTargetChain,
			publicClient,
			writer,
		],
	);

	return useMemo(
		() => ({
			status: tracker.status,
			lastAction: tracker.action,
			txHash: tracker.currentHash,
			originalTxHash: tracker.originalHash,
			replacementHash: tracker.replacementHash,
			replacementReason: tracker.replacementReason,
			error: tracker.error,
			unresolved,
			trackerReady,
			wrongChain,
			switching,
			switchToTargetChain,
			reset,

			placeBid: (valueWei: bigint) => void send("placeBid", [], valueWei),
			increaseBid: (bidId: number, addWei: bigint) =>
				void send("increaseBid", [bidId], addWei),
			withdraw: () => void send("withdraw", []),
			finalize: (batch: number) => void send("finalize", [BigInt(batch)]),
			cancelAuction: () => void send("cancelAuction", []),
			refundAll: (batch: number) => void send("refundAll", [BigInt(batch)]),
			emergencyRefund: (batch: number) =>
				void send("emergencyRefund", [BigInt(batch)]),
			recoverFromSupplyMismatch: (batch: number) =>
				void send("recoverFromSupplyMismatch", [BigInt(batch)]),
			recoverFromMintingUnavailable: (batch: number) =>
				void send("recoverFromMintingUnavailable", [BigInt(batch)]),
			setPaused: (paused: boolean) => void send("setPaused", [paused]),
		}),
		[
			tracker,
			unresolved,
			trackerReady,
			wrongChain,
			switching,
			switchToTargetChain,
			reset,
			send,
		],
	);
}

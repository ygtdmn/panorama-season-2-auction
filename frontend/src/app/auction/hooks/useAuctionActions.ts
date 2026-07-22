"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import {
	TransactionNotFoundError,
	TransactionReceiptNotFoundError,
	type Hash,
	type TransactionReceipt,
} from "viem";
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
	/** Epoch ms the wallet returned the hash, for "how long has this been unresolved" copy. */
	submittedAt?: number;
	/**
	 * Releases an indeterminate transaction by hand. Last resort for the case no probe can
	 * settle (an RPC that can neither produce a receipt nor admit the transaction is gone).
	 */
	forceUnlock: () => void;
	/** True when the current terminal state came from `forceUnlock`, not from chain evidence. */
	lockReleasedManually: boolean;
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
// The presence prober runs beside the receipt watcher and answers a different question: is this
// transaction still on the network at all? It only starts once a transaction has had time to
// propagate, and only concludes after several consecutive "no such transaction" answers, so a
// single lagging RPC in the fallback list can never unlock the form on its own.
const PROBE_INTERVAL_MS = 6_000;
const PROBE_START_AFTER_MS = 20_000;
const PROBE_MISSES_WITH_NONCE = 3;
const PROBE_MISSES_WITHOUT_NONCE = 6;
// Pending records are scoped per wallet: wallet B must never be locked by (or toast for)
// wallet A's unresolved transaction. The unscoped prefix is also the pre-scoping legacy key.
const PENDING_STORAGE_PREFIX = `panorama-auction:pending:${TARGET_CHAIN.id}:${PANORAMA_AUCTION_ADDRESS.toLowerCase()}`;
function pendingStorageKey(account: `0x${string}`): string {
	return `${PENDING_STORAGE_PREFIX}:${account.toLowerCase()}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True only when the RPC positively answered "I have no such transaction/receipt". A transport
 * failure, a rate limit, or any other error proves nothing and must never count as absence.
 */
function isNotFoundError(error: unknown): boolean {
	if (error instanceof TransactionNotFoundError || error instanceof TransactionReceiptNotFoundError) {
		return true;
	}
	const name = (error as { name?: string } | null)?.name;
	return name === "TransactionNotFoundError" || name === "TransactionReceiptNotFoundError";
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
	// The wallet the in-memory tracker was hydrated for ("disconnected" when none). Until it
	// matches the connected wallet, writes stay locked: this closes the one-render window
	// after an account switch where the previous wallet's tracker is still in memory.
	const [hydratedFor, setHydratedFor] = useState<string | null>(null);
	const notifiedHashRef = useRef<Hash | undefined>(undefined);
	// Mirrored in a ref so learning the nonce mid-flight does not restart the watcher loops.
	const nonceRef = useRef<number | undefined>(undefined);

	const wrongChain = chainId !== TARGET_CHAIN.id;
	const trackerReady = hydratedFor === (address ?? "disconnected");
	const unresolved = !trackerReady || isTransactionUnresolved(tracker.status);

	// Restore the CONNECTED wallet's unresolved transaction before enabling any write. A reload
	// must not create a duplicate bid merely because React forgot the receipt query, and another
	// wallet's record must neither lock this session nor fire its completion surfaces here.
	useEffect(() => {
		let restored: ReturnType<typeof hydratePersistedTransaction<WriteName>> = null;
		if (address) {
			try {
				// Drop any pre-account-scoping record: it cannot prove which wallet it belongs to.
				window.localStorage.removeItem(PENDING_STORAGE_PREFIX);
				const key = pendingStorageKey(address);
				const raw = window.localStorage.getItem(key);
				if (raw) {
					restored = hydratePersistedTransaction<WriteName>(JSON.parse(raw), address);
					if (!restored) window.localStorage.removeItem(key);
				}
			} catch {
				// Storage may be unavailable in hardened/private contexts. In-memory tracking still works.
			}
		}
		dispatch({
			type: "hydrate",
			tracker: restored ?? emptyTransactionTracker<WriteName>(),
		});
		setHydratedFor(address ?? "disconnected");
	}, [address]);

	useEffect(() => {
		if (!trackerReady) return;
		// Persist only under the owning wallet's key. An empty tracker carries no account and
		// therefore never deletes another wallet's still-pending record.
		const account = tracker.account;
		if (!account || !address || account.toLowerCase() !== address.toLowerCase()) return;
		try {
			const key = pendingStorageKey(account);
			const persisted = persistableTransaction(tracker);
			if (persisted) {
				window.localStorage.setItem(key, JSON.stringify(persisted));
			} else {
				window.localStorage.removeItem(key);
			}
		} catch {
			// See storage note above.
		}
	}, [tracker, trackerReady, address]);

	useEffect(() => {
		writeLockRef.current = isTransactionUnresolved(tracker.status);
	}, [tracker.status]);

	useEffect(() => {
		nonceRef.current = tracker.nonce;
	}, [tracker.nonce]);

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

	// Presence prober. The receipt watcher above can only ever resolve a transaction that mines;
	// a dropped transaction, or one whose nonce a wallet-side speed-up/cancel consumed after a
	// reload (viem can no longer arm replacement detection then), produces no receipt ever and
	// used to lock the form permanently. This resolves those two cases from evidence:
	//   nonce consumed by something else + no receipt for our hash -> our action did not execute
	//   nonce still free + the network does not know the hash      -> dropped, never mined
	// A resend reuses the same nonce, so at most one of the two can ever land.
	useEffect(() => {
		if (!trackerReady || !publicClient || !tracker.originalHash || !tracker.account) return;
		if (!isTransactionUnresolved(tracker.status)) return;

		const account = tracker.account;
		const originalHash = tracker.originalHash;
		const currentHash = tracker.currentHash ?? originalHash;
		const submittedAt = tracker.submittedAt ?? Date.now();
		let stopped = false;
		let misses = 0;

		const receiptFor = async (hash: Hash): Promise<TransactionReceipt | null> => {
			try {
				return await publicClient.getTransactionReceipt({ hash });
			} catch {
				return null;
			}
		};

		const probe = async () => {
			if (Date.now() - submittedAt < PROBE_START_AFTER_MS) return;

			// Receipt truth always wins over any absence evidence.
			const receipt =
				(await receiptFor(currentHash)) ??
				(currentHash === originalHash ? null : await receiptFor(originalHash));
			if (stopped) return;
			if (receipt) {
				writeLockRef.current = false;
				dispatch({
					type: "receipt",
					receiptStatus: receipt.status,
					error: receipt.status === "reverted" ? revertedError() : undefined,
				});
				return;
			}

			let known = false;
			try {
				const tx = await publicClient.getTransaction({ hash: currentHash });
				known = true;
				if (nonceRef.current === undefined && typeof tx.nonce === "number") {
					nonceRef.current = tx.nonce;
					dispatch({ type: "nonce", nonce: tx.nonce });
				}
			} catch (error) {
				// Only a definitive "not found" counts; anything else is an unusable answer.
				if (!isNotFoundError(error)) return;
			}
			if (stopped) return;
			if (known) {
				misses = 0;
				return;
			}

			misses += 1;
			const nonce = nonceRef.current;
			if (nonce !== undefined) {
				let confirmedNonce: number;
				try {
					confirmedNonce = await publicClient.getTransactionCount({
						address: account,
						blockTag: "latest",
					});
				} catch {
					return;
				}
				if (stopped) return;
				if (confirmedNonce > nonce) {
					dispatch({ type: "vanished", kind: "replaced" });
					return;
				}
				if (misses >= PROBE_MISSES_WITH_NONCE) dispatch({ type: "vanished", kind: "dropped" });
				return;
			}
			if (misses >= PROBE_MISSES_WITHOUT_NONCE) dispatch({ type: "vanished", kind: "dropped" });
		};

		const timer = window.setInterval(() => void probe(), PROBE_INTERVAL_MS);
		void probe();
		return () => {
			stopped = true;
			window.clearInterval(timer);
		};
	}, [
		publicClient,
		tracker.account,
		tracker.currentHash,
		tracker.originalHash,
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

	// Manual release. Deliberately not wired to `reset()`: it stays a separate, explicitly
	// confirmed action so no ordinary status handler can clear an unresolved transaction.
	const forceUnlock = useCallback(() => {
		if (!isTransactionUnresolved(tracker.status)) return;
		writeLockRef.current = false;
		writer.reset();
		dispatch({ type: "vanished", kind: "dropped", forced: true });
	}, [tracker.status, writer]);

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
				// Best effort, while the transaction is certainly still in the mempool: the nonce is
				// what later proves whether a missing transaction was replaced or simply dropped.
				void (async () => {
					for (let attempt = 0; attempt < 3; attempt++) {
						try {
							const tx = await publicClient.getTransaction({ hash });
							nonceRef.current = tx.nonce;
							dispatch({ type: "nonce", nonce: tx.nonce });
							return;
						} catch {
							await sleep(1_000);
						}
					}
				})();
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
			submittedAt: tracker.submittedAt,
			forceUnlock,
			lockReleasedManually: tracker.forcedUnlock === true,
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
			forceUnlock,
			wrongChain,
			switching,
			switchToTargetChain,
			reset,
			send,
		],
	);
}

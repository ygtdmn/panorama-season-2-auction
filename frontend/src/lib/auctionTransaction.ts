import type { Hash, TransactionReceipt } from "viem";

export type ReplacementReason = "cancelled" | "replaced" | "repriced";

export type TransactionStatus =
	| "idle"
	| "signing"
	| "pending"
	| "unknown"
	| "success"
	| "error"
	| "cancelled"
	| "replaced";

export interface TransactionTracker<Action extends string = string> {
	status: TransactionStatus;
	action?: Action;
	account?: `0x${string}`;
	originalHash?: Hash;
	currentHash?: Hash;
	replacementHash?: Hash;
	replacementReason?: ReplacementReason;
	submittedAt?: number;
	error: Error | null;
}

export type TransactionTrackerEvent<Action extends string = string> =
	| { type: "begin"; action: Action; account: `0x${string}` }
	| { type: "submitted"; hash: Hash; submittedAt: number }
	| { type: "delayed" }
	| { type: "replacement"; hash: Hash; reason: ReplacementReason }
	| { type: "receipt"; receiptStatus: TransactionReceipt["status"]; error?: Error }
	| { type: "preflight-error"; error: Error }
	| { type: "wait-error"; error: Error }
	| { type: "hydrate"; tracker: TransactionTracker<Action> }
	| { type: "reset" };

export function emptyTransactionTracker<Action extends string = string>(): TransactionTracker<Action> {
	return { status: "idle", error: null };
}

/** Signing, pending, and unknown all block another write. "Unknown" means no terminal receipt. */
export function isTransactionUnresolved(status: TransactionStatus): boolean {
	return status === "signing" || status === "pending" || status === "unknown";
}

/**
 * Pure transaction state machine. In particular, a polling timeout/transport error after a hash
 * exists is never terminal: it becomes `unknown` and remains locked until receipt truth arrives.
 */
export function transactionTrackerReducer<Action extends string>(
	state: TransactionTracker<Action>,
	event: TransactionTrackerEvent<Action>,
): TransactionTracker<Action> {
	switch (event.type) {
		case "begin":
			if (isTransactionUnresolved(state.status)) return state;
			return {
				status: "signing",
				action: event.action,
				account: event.account,
				error: null,
			};
		case "submitted":
			return {
				...state,
				status: "pending",
				originalHash: event.hash,
				currentHash: event.hash,
				submittedAt: event.submittedAt,
				error: null,
			};
		case "delayed":
			return state.status === "pending" ? { ...state, status: "unknown" } : state;
		case "replacement":
			return {
				...state,
				currentHash: event.hash,
				replacementHash: event.hash,
				replacementReason: event.reason,
			};
		case "receipt": {
			// A wallet cancellation or a different replacement transaction confirms that the
			// original auction action did not execute. A fee-only reprice still did.
			if (state.replacementReason === "cancelled") {
				return { ...state, status: "cancelled", error: null };
			}
			if (state.replacementReason === "replaced") {
				return { ...state, status: "replaced", error: null };
			}
			if (event.receiptStatus === "reverted") {
				return {
					...state,
					status: "error",
					error: event.error ?? new Error("Transaction reverted on-chain."),
				};
			}
			return { ...state, status: "success", error: null };
		}
		case "preflight-error":
			return { ...state, status: "error", error: event.error };
		case "wait-error":
			// Once a hash exists, an RPC failure cannot prove that the transaction failed.
			return state.originalHash
				? { ...state, status: "unknown", error: event.error }
				: { ...state, status: "error", error: event.error };
		case "hydrate":
			return event.tracker;
		case "reset":
			return isTransactionUnresolved(state.status) ? state : emptyTransactionTracker<Action>();
	}
}

export interface PersistedTransaction<Action extends string = string> {
	version: 1;
	action: Action;
	account: `0x${string}`;
	originalHash: Hash;
	currentHash: Hash;
	replacementHash?: Hash;
	replacementReason?: ReplacementReason;
	submittedAt: number;
}

export function persistableTransaction<Action extends string>(
	tracker: TransactionTracker<Action>,
): PersistedTransaction<Action> | null {
	if (
		!isTransactionUnresolved(tracker.status) ||
		!tracker.action ||
		!tracker.account ||
		!tracker.originalHash ||
		!tracker.currentHash ||
		!tracker.submittedAt
	) {
		return null;
	}
	return {
		version: 1,
		action: tracker.action,
		account: tracker.account,
		originalHash: tracker.originalHash,
		currentHash: tracker.currentHash,
		replacementHash: tracker.replacementHash,
		replacementReason: tracker.replacementReason,
		submittedAt: tracker.submittedAt,
	};
}

export function hydratePersistedTransaction<Action extends string>(
	value: unknown,
): TransactionTracker<Action> | null {
	if (!value || typeof value !== "object") return null;
	const p = value as Partial<PersistedTransaction<Action>>;
	if (
		p.version !== 1 ||
		typeof p.action !== "string" ||
		typeof p.account !== "string" ||
		!/^0x[0-9a-fA-F]{40}$/.test(p.account) ||
		typeof p.originalHash !== "string" ||
		!/^0x[0-9a-fA-F]{64}$/.test(p.originalHash) ||
		typeof p.currentHash !== "string" ||
		!/^0x[0-9a-fA-F]{64}$/.test(p.currentHash) ||
		typeof p.submittedAt !== "number"
	) {
		return null;
	}
	return {
		status: "unknown",
		action: p.action as Action,
		account: p.account as `0x${string}`,
		originalHash: p.originalHash as Hash,
		currentHash: p.currentHash as Hash,
		replacementHash: p.replacementHash as Hash | undefined,
		replacementReason: p.replacementReason,
		submittedAt: p.submittedAt,
		error: null,
	};
}

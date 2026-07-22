import { describe, expect, it } from "vitest";
import {
	emptyTransactionTracker,
	hydratePersistedTransaction,
	isTransactionUnresolved,
	persistableTransaction,
	transactionTrackerReducer,
} from "@/lib/auctionTransaction";

const account = "0x1111111111111111111111111111111111111111" as const;
const original = `0x${"1".repeat(64)}` as const;
const replacement = `0x${"2".repeat(64)}` as const;

function submitted() {
	let tracker = emptyTransactionTracker<"placeBid">();
	tracker = transactionTrackerReducer(tracker, {
		type: "begin",
		action: "placeBid",
		account,
	});
	return transactionTrackerReducer(tracker, {
		type: "submitted",
		hash: original,
		submittedAt: 123,
	});
}

describe("auction transaction tracking", () => {
	it("keeps a delayed submitted transaction unresolved", () => {
		const delayed = transactionTrackerReducer(submitted(), { type: "delayed" });
		expect(delayed.status).toBe("unknown");
		expect(delayed.originalHash).toBe(original);
		expect(isTransactionUnresolved(delayed.status)).toBe(true);
		expect(transactionTrackerReducer(delayed, { type: "reset" })).toEqual(delayed);
	});

	it("treats an RPC wait error after a hash as unknown, never as a failed bid", () => {
		const failedWait = transactionTrackerReducer(submitted(), {
			type: "wait-error",
			error: new Error("timeout"),
		});
		expect(failedWait.status).toBe("unknown");
		expect(failedWait.error?.message).toBe("timeout");
	});

	it("persists and restores the unresolved hash across reloads", () => {
		const persisted = persistableTransaction(submitted());
		expect(persisted).not.toBeNull();
		const hydrated = hydratePersistedTransaction<"placeBid">(persisted);
		expect(hydrated?.status).toBe("unknown");
		expect(hydrated?.originalHash).toBe(original);
		expect(hydrated?.currentHash).toBe(original);
	});

	it("tracks fee replacements to success", () => {
		let tracker = transactionTrackerReducer(submitted(), {
			type: "replacement",
			hash: replacement,
			reason: "repriced",
		});
		tracker = transactionTrackerReducer(tracker, {
			type: "receipt",
			receiptStatus: "success",
		});
		expect(tracker.status).toBe("success");
		expect(tracker.originalHash).toBe(original);
		expect(tracker.currentHash).toBe(replacement);
	});

	it("distinguishes cancelled and different replacement transactions", () => {
		for (const reason of ["cancelled", "replaced"] as const) {
			let tracker = transactionTrackerReducer(submitted(), {
				type: "replacement",
				hash: replacement,
				reason,
			});
			tracker = transactionTrackerReducer(tracker, {
				type: "receipt",
				receiptStatus: "success",
			});
			expect(tracker.status).toBe(reason);
			expect(isTransactionUnresolved(tracker.status)).toBe(false);
		}
	});

	it("unlocks a transaction that vanished from the network", () => {
		const delayed = transactionTrackerReducer(submitted(), { type: "delayed" });
		const dropped = transactionTrackerReducer(delayed, { type: "vanished", kind: "dropped" });
		expect(dropped.status).toBe("dropped");
		expect(isTransactionUnresolved(dropped.status)).toBe(false);
		expect(dropped.error).toBeNull();

		const replacedOut = transactionTrackerReducer(delayed, { type: "vanished", kind: "replaced" });
		expect(replacedOut.status).toBe("replaced");
		expect(isTransactionUnresolved(replacedOut.status)).toBe(false);
	});

	it("never lets a vanish verdict overwrite a settled outcome", () => {
		const mined = transactionTrackerReducer(submitted(), {
			type: "receipt",
			receiptStatus: "success",
		});
		expect(transactionTrackerReducer(mined, { type: "vanished", kind: "dropped" })).toEqual(mined);
	});

	it("marks a manual release so the copy cannot claim proof it does not have", () => {
		const delayed = transactionTrackerReducer(submitted(), { type: "delayed" });
		const forced = transactionTrackerReducer(delayed, {
			type: "vanished",
			kind: "dropped",
			forced: true,
		});
		expect(forced.forcedUnlock).toBe(true);
		const automatic = transactionTrackerReducer(delayed, { type: "vanished", kind: "dropped" });
		expect(automatic.forcedUnlock).toBeUndefined();
	});

	it("round-trips the nonce so a reload can still tell dropped from replaced", () => {
		const withNonce = transactionTrackerReducer(submitted(), { type: "nonce", nonce: 7 });
		expect(withNonce.nonce).toBe(7);
		const persisted = persistableTransaction(withNonce);
		expect(persisted?.nonce).toBe(7);
		expect(hydratePersistedTransaction(persisted, account)?.nonce).toBe(7);
		expect(
			hydratePersistedTransaction({ ...persisted, nonce: "7" }, account)?.nonce,
		).toBeUndefined();
	});

	it("rejects malformed persisted data", () => {
		expect(hydratePersistedTransaction({ version: 1, originalHash: "0x1" })).toBeNull();
	});

	it("restores only into the session of the wallet that submitted it", () => {
		const persisted = persistableTransaction(submitted());
		const otherWallet = "0x2222222222222222222222222222222222222222" as const;
		expect(hydratePersistedTransaction(persisted, otherWallet)).toBeNull();
		expect(hydratePersistedTransaction(persisted, account)?.status).toBe("unknown");
		// Address casing must not defeat the guard.
		expect(
			hydratePersistedTransaction(
				persisted,
				account.toUpperCase().replace("0X", "0x") as `0x${string}`,
			)?.status,
		).toBe("unknown");
	});
});

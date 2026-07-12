// In-memory demo engine that mirrors PanoramaSeason2Auction so the UI can be exercised
// end-to-end without a deployed contract. Client-side only; state is module-level and
// resets on a hard page reload (survives client-side nav).
//
// Parity rules (kept in lockstep with the Solidity):
// - minimum bid when full = floor + CEIL(floor * bps / 10000)
// - inside the last 5 minutes, a raise below the extension threshold REVERTS
// - extensions move the end to now + 10m, capped at scheduledEnd + 24h (absoluteEndTime)
// - displacement and settlement excess are pushed straight back to the wallet (the pull
//   ledger only holds failed pushes, which cannot happen in the demo, so withdraw stays empty)
// - equal bids: the earlier bid id wins the earlier reveal slot
// - clearing price = floor when 90/90, reserve otherwise; every winner pays it

export type DemoPhaseNum = 0 | 1 | 2 | 3; // Active, Finalizing, Settled, Cancelled

// Every reviewable UI state, reachable in one click from the demo bar.
export type DemoScenario =
	| "upcoming"
	| "empty"
	| "bidding"
	| "full"
	| "paused"
	| "ended"
	| "settling"
	| "settled"
	| "cancelled"
	| "emergency";

export const DEMO_SCENARIOS: { key: DemoScenario; label: string }[] = [
	{ key: "upcoming", label: "upcoming" },
	{ key: "empty", label: "empty" },
	{ key: "bidding", label: "bidding" },
	{ key: "full", label: "full 90/90" },
	{ key: "paused", label: "paused" },
	{ key: "ended", label: "ended" },
	{ key: "settling", label: "settling" },
	{ key: "settled", label: "settled" },
	{ key: "cancelled", label: "cancelled" },
	{ key: "emergency", label: "emergency" },
];

export interface DemoBid {
	id: number;
	bidder: string;
	amount: bigint;
}

export interface DemoWon {
	id: number;
	bidder: string;
	amount: bigint;
	tokenId: number;
	pricePaid: bigint;
}

export interface DemoSnapshot {
	started: boolean;
	phase: DemoPhaseNum;
	paused: boolean;
	startTime: number;
	endTime: number;
	scheduledEndTime: number;
	absoluteEndTime: number;
	extensionCount: number;
	bids: DemoBid[];
	won: DemoWon[]; // minted winners, in mint order (mirrors Won events)
	clearingPrice: bigint;
	proceeds: bigint;
	winnerCount: number;
	finalizeCursor: number;
	refundsComplete: boolean;
	pending: Record<string, bigint>; // pull ledger: failed pushes only (empty in demo)
	you: string;
	log: string[];
	actionStatus: "idle" | "success" | "error";
	actionError: string | null;
}

export const DEMO_MAX_UNITS = 90;
export const DEMO_MAX_BIDS_PER_WALLET = 4;
// 0.1 ETH: equals the contract's MIN_RESERVE_PRICE floor (bids below it are rejected).
export const DEMO_RESERVE = 100_000_000_000_000_000n;
export const DEMO_INC_BPS = 500; // 5%
export const DEMO_DURATION = 24 * 3600;
export const DEMO_EXT_WINDOW = 5 * 60;
export const DEMO_EXT_LEN = 10 * 60;
export const DEMO_MAX_TOTAL_EXTENSION = 24 * 3600;
export const DEMO_FINALIZE_GRACE = 7 * 24 * 3600;
export const DEMO_EMERGENCY_GRACE = 30 * 24 * 3600;
const BPS = 10_000n;
const SPLIT_A_BPS = 5_800n;
const FIRST_TOKEN_ID = 91;

export const DEMO_PAYOUT_A = "0x" + "a".repeat(40);
export const DEMO_PAYOUT_B = "0x" + "b".repeat(40);
export const DEMO_IDENTITIES = [
	"0x" + "d0".repeat(20),
	"0x" + "d1".repeat(20),
	"0x" + "d2".repeat(20),
];

const now = () => Math.floor(Date.now() / 1000);
const padAddr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const rand = (max: number) => Math.floor(Math.random() * max);

/** Ceiling basis-point increment, identical to the contract's `_bpsIncrement`. */
export function bpsIncrement(amount: bigint, bps: number = DEMO_INC_BPS): bigint {
	return (amount * BigInt(bps) + BPS - 1n) / BPS;
}

function initial(): DemoSnapshot {
	return {
		started: false,
		phase: 0,
		paused: false,
		startTime: 0,
		endTime: 0,
		scheduledEndTime: 0,
		absoluteEndTime: 0,
		extensionCount: 0,
		bids: [],
		won: [],
		clearingPrice: 0n,
		proceeds: 0n,
		winnerCount: 0,
		finalizeCursor: 0,
		refundsComplete: false,
		pending: {},
		you: DEMO_IDENTITIES[0],
		log: [],
		actionStatus: "idle",
		actionError: null,
	};
}

let state: DemoSnapshot = initial();
let nextId = 1;
let seedCounter = 0x51d000;
const listeners = new Set<() => void>();

const serverSnapshot: DemoSnapshot = initial();

function emit() {
	// New reference so useSyncExternalStore detects the change.
	state = { ...state };
	for (const l of listeners) l();
}

function log(msg: string) {
	state.log = [`${new Date().toLocaleTimeString()}  ${msg}`, ...state.log].slice(0, 40);
}

function fmt(wei: bigint) {
	return `${Number(wei) / 1e18} ETH`;
}

// --- derived helpers -------------------------------------------------------

export function isFull() {
	return state.bids.length >= DEMO_MAX_UNITS;
}

export function lowestBid(): DemoBid | null {
	if (state.bids.length === 0) return null;
	// Equal amounts: the LATER bid id is the worse one (it sits at the heap root), matching
	// the contract's displacement order.
	return state.bids.reduce(
		(lo, b) => (b.amount < lo.amount || (b.amount === lo.amount && b.id > lo.id) ? b : lo),
		state.bids[0],
	);
}

export function minimumBid(): bigint {
	if (!isFull()) return DEMO_RESERVE;
	const floor = lowestBid()!.amount;
	return floor + bpsIncrement(floor);
}

export function currentClearing(): bigint {
	return isFull() ? lowestBid()!.amount : DEMO_RESERVE;
}

function biddable(): { ok: boolean; reason?: string } {
	if (state.phase !== 0) return { ok: false, reason: "The auction is not accepting bids." };
	if (state.paused) return { ok: false, reason: "Bidding is paused." };
	const t = now();
	if (t < state.startTime) return { ok: false, reason: "Bidding has not opened yet." };
	if (t >= state.endTime) return { ok: false, reason: "Bidding has ended." };
	return { ok: true };
}

function inExtensionWindow(): boolean {
	return now() + DEMO_EXT_WINDOW >= state.endTime;
}

function maybeExtend() {
	// Anti-snipe: extend to now + 10m, never past absoluteEndTime (scheduled end + 24h).
	if (inExtensionWindow()) {
		let newEnd = now() + DEMO_EXT_LEN;
		if (newEnd > state.absoluteEndTime) newEnd = state.absoluteEndTime;
		if (newEnd > state.endTime) {
			state.endTime = newEnd;
			state.extensionCount += 1;
			log(`Anti-snipe: extended to +${Math.round((newEnd - now()) / 60)}m (extension ${state.extensionCount})`);
		}
	}
}

function releaseProceedsIfDone() {
	if (state.proceeds > 0n) {
		const a = (state.proceeds * SPLIT_A_BPS) / BPS;
		const bShare = state.proceeds - a;
		log(`Proceeds released: ${fmt(state.proceeds)} → A ${fmt(a)} / B ${fmt(bShare)}`);
	}
}

// --- store api -------------------------------------------------------------

export const demoStore = {
	subscribe(l: () => void) {
		listeners.add(l);
		return () => listeners.delete(l);
	},
	getSnapshot() {
		return state;
	},
	getServerSnapshot() {
		return serverSnapshot;
	},

	start(seed = true) {
		if (state.started) return;
		state.started = true;
		state.startTime = now();
		state.endTime = now() + DEMO_DURATION;
		state.scheduledEndTime = state.endTime;
		state.absoluteEndTime = state.endTime + DEMO_MAX_TOTAL_EXTENSION;
		if (seed) {
			// Seed competing bids with a wide spread so the ladder reads well.
			for (let i = 0; i < 11; i++) {
				state.bids.push({
					id: nextId++,
					bidder: padAddr(seedCounter++),
					amount: DEMO_RESERVE + BigInt(rand(600)) * 1_000_000_000_000_000n,
				});
			}
			log("Demo auction started with 11 seed bids.");
		} else {
			log("Demo reset to an empty auction.");
		}
		emit();
	},

	// Reset clears to a clean, empty board so the flow can be tested from zero bids.
	reset() {
		state = initial();
		nextId = 1;
		seedCounter = 0x51d000;
		this.start(false);
	},

	// Put the auction into the pre-open "upcoming" state: it opens in one day, so the
	// header counts down to the start with an empty board.
	setUpcoming() {
		this.jumpTo("upcoming");
	},

	// Jump straight to any UI state so every branch can be reviewed with one click.
	jumpTo(scenario: DemoScenario) {
		state = initial();
		nextId = 1;
		seedCounter = 0x51d000;
		const t = now();

		// Open the auction with a start/end schedule. `openedAgo` seconds in the past
		// (or negative to schedule a future open for the "upcoming" state).
		const open = (openedAgo: number) => {
			state.started = true;
			state.startTime = t - openedAgo;
			state.endTime = state.startTime + DEMO_DURATION;
			state.scheduledEndTime = state.endTime;
			state.absoluteEndTime = state.endTime + DEMO_MAX_TOTAL_EXTENSION;
		};
		const seed = (n: number, includeYou = false) => {
			for (let i = 0; i < n; i++) {
				state.bids.push({
					id: nextId++,
					bidder: padAddr(seedCounter++),
					amount: DEMO_RESERVE + BigInt(50 + rand(600)) * 1_000_000_000_000_000n,
				});
			}
			if (includeYou) {
				state.bids.push({
					id: nextId++,
					bidder: state.you,
					amount: DEMO_RESERVE + 320_000_000_000_000_000n,
				});
			}
		};
		// Mint winners highest-first, exactly like finalize(), without touching action status.
		const settle = (mintAll: boolean) => {
			state.clearingPrice = currentClearing();
			state.bids.sort((a, b) =>
				a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : a.id - b.id,
			);
			state.winnerCount = state.bids.length;
			const target = mintAll ? state.bids.length : Math.ceil(state.bids.length / 2);
			const cp = state.clearingPrice;
			for (let i = 0; i < target; i++) {
				const bid = state.bids.shift()!;
				state.won.push({
					id: bid.id,
					bidder: bid.bidder,
					amount: bid.amount,
					tokenId: FIRST_TOKEN_ID + state.finalizeCursor,
					pricePaid: cp,
				});
				state.finalizeCursor += 1;
				state.proceeds += cp;
			}
			state.phase = state.bids.length === 0 ? 2 : 1;
		};

		switch (scenario) {
			case "upcoming":
				open(-24 * 3600); // opens in 1 day
				break;
			case "empty":
				open(3600);
				break;
			case "bidding":
				open(3600);
				seed(10, true);
				break;
			case "full":
				open(3600);
				seed(90);
				break;
			case "paused":
				open(3600);
				seed(10, true);
				state.paused = true;
				break;
			case "ended":
				open(DEMO_DURATION + 120);
				seed(20, true);
				state.endTime = t - 30; // closed, awaiting settlement
				break;
			case "settling":
				open(DEMO_DURATION + 120);
				seed(20, true);
				state.endTime = t - 30;
				settle(false); // phase 1, minted partway
				break;
			case "settled":
				open(DEMO_DURATION + 120);
				seed(20, true);
				state.endTime = t - 30;
				settle(true); // phase 2, all minted
				// A failed excess push would land in the pull ledger; seed one so the
				// "Refund available / withdraw" panel is visible too.
				state.pending[state.you] = 120_000_000_000_000_000n;
				break;
			case "cancelled":
				open(3600);
				seed(20, true);
				state.phase = 3; // cancelled with bids still owed refunds
				break;
			case "emergency":
				open(DEMO_DURATION + DEMO_EMERGENCY_GRACE + 300);
				seed(20, true);
				// endTime and absoluteEndTime far enough back that the emergency window is open.
				state.endTime = t - DEMO_EMERGENCY_GRACE - 200;
				state.absoluteEndTime = t - DEMO_EMERGENCY_GRACE - 100;
				break;
		}
		log(`Jumped to "${scenario}".`);
		emit();
	},

	setStatus(s: DemoSnapshot["actionStatus"], err: string | null = null) {
		state.actionStatus = s;
		state.actionError = err;
		emit();
	},

	setYou(addr: string) {
		state.you = addr;
		emit();
	},

	setPaused(p: boolean) {
		state.paused = p;
		log(p ? "Bidding paused." : "Bidding unpaused.");
		emit();
	},

	endNow() {
		state.endTime = now();
		if (state.absoluteEndTime < state.endTime) state.absoluteEndTime = state.endTime;
		log("Auction time ended (demo control).");
		emit();
	},

	placeBid(from: string, amount: bigint) {
		const b = biddable();
		if (!b.ok) return this.setStatus("error", b.reason);
		const count = state.bids.filter((x) => x.bidder === from).length;
		if (count >= DEMO_MAX_BIDS_PER_WALLET)
			return this.setStatus("error", "This wallet already holds the maximum of 4 bids.");
		if (amount < DEMO_RESERVE)
			return this.setStatus("error", `Bid is below the reserve (${fmt(DEMO_RESERVE)}).`);

		if (isFull()) {
			const min = minimumBid();
			if (amount < min)
				return this.setStatus("error", `Bid too low. The minimum right now is ${fmt(min)}.`);
			const low = lowestBid()!;
			state.bids = state.bids.filter((x) => x.id !== low.id);
			// The contract force-sends the refund to the wallet; nothing lands in the pull ledger.
			log(`Displaced #${low.id} (${fmt(low.amount)}) → refunded straight to ${short(low.bidder)}`);
		}

		state.bids.push({ id: nextId++, bidder: from, amount });
		// A new accepted bid always qualifies for the anti-snipe extension.
		maybeExtend();
		log(`Bid ${fmt(amount)} from ${short(from)}`);
		this.setStatus("success");
	},

	increaseBid(from: string, id: number, add: bigint) {
		const b = biddable();
		if (!b.ok) return this.setStatus("error", b.reason);
		const bid = state.bids.find((x) => x.id === id && x.bidder === from);
		if (!bid) return this.setStatus("error", "That bid belongs to a different wallet.");
		if (add <= 0n) return this.setStatus("error", "Enter an amount to raise by.");

		// Contract rule: inside the extension window, raises below the floor-based threshold
		// revert so a competitive raise cannot be split into dust to dodge the anti-snipe.
		const threshold = bpsIncrement(lowestBid()!.amount);
		if (inExtensionWindow() && add < threshold) {
			return this.setStatus(
				"error",
				`Raises in the final five minutes must add at least ${fmt(threshold)}.`,
			);
		}

		bid.amount += add;
		if (add >= threshold) maybeExtend();
		log(`Raised #${id} by ${fmt(add)} → ${fmt(bid.amount)}`);
		this.setStatus("success");
	},

	withdraw(from: string) {
		const amt = state.pending[from] ?? 0n;
		if (amt === 0n) return this.setStatus("error", "Nothing to withdraw for this wallet.");
		state.pending[from] = 0n;
		log(`Withdrew ${fmt(amt)} to ${short(from)}`);
		this.setStatus("success");
	},

	finalize(batch: number) {
		if (state.phase !== 0 && state.phase !== 1)
			return this.setStatus("error", "Settlement is not available in this phase.");
		if (now() < state.endTime) return this.setStatus("error", "The auction has not ended yet.");
		if (batch < 1) return this.setStatus("error", "Batch size must be at least 1.");

		if (state.phase === 0) {
			state.clearingPrice = currentClearing();
			// Mint highest bid first; equal amounts go to the earlier bid id (earlier reveal).
			state.bids.sort((a, b) =>
				a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : a.id - b.id,
			);
			state.winnerCount = state.bids.length;
			state.finalizeCursor = 0;
			state.phase = 1;
			log(
				`Finalizing. Clearing price = ${fmt(state.clearingPrice)}, winners = ${state.winnerCount}`,
			);
		}

		const cp = state.clearingPrice;
		let processed = 0;
		while (state.bids.length > 0 && processed < batch) {
			const bid = state.bids.shift()!;
			const tokenId = FIRST_TOKEN_ID + state.finalizeCursor;
			state.won.push({ id: bid.id, bidder: bid.bidder, amount: bid.amount, tokenId, pricePaid: cp });
			state.finalizeCursor += 1;
			state.proceeds += cp;
			const excess = bid.amount - cp;
			// Excess is pushed straight back to the winner's wallet (pull ledger only on failure).
			if (excess > 0n) log(`Excess ${fmt(excess)} refunded straight to ${short(bid.bidder)}`);
			processed += 1;
		}
		log(`Finalized batch of ${processed}. Remaining: ${state.bids.length}`);

		if (state.bids.length === 0) {
			state.phase = 2;
			releaseProceedsIfDone();
			log(`Settled. ${state.winnerCount} winners at ${fmt(cp)} each.`);
		}
		this.setStatus("success");
	},

	cancel() {
		if (state.phase !== 0)
			return this.setStatus("error", "The auction can only be cancelled while active.");
		state.phase = 3;
		if (state.bids.length === 0) {
			state.refundsComplete = true;
			releaseProceedsIfDone();
			log("Auction cancelled with no bids. Recovery complete.");
		} else {
			log("Auction cancelled. Run refundAll to return bids.");
		}
		this.setStatus("success");
	},

	refundAll(batch: number) {
		if (state.phase !== 3) return this.setStatus("error", "Refund-all needs a cancelled auction.");
		if (state.refundsComplete) return this.setStatus("error", "Refunds are already complete.");
		if (batch < 1) return this.setStatus("error", "Batch size must be at least 1.");
		let processed = 0;
		while (state.bids.length > 0 && processed < batch) {
			const bid = state.bids.shift()!;
			log(`Refunded ${fmt(bid.amount)} straight to ${short(bid.bidder)}`);
			processed += 1;
		}
		log(`Refunded batch of ${processed}. Remaining: ${state.bids.length}`);
		if (state.bids.length === 0) {
			state.refundsComplete = true;
			releaseProceedsIfDone();
			log("Recovery complete.");
		}
		this.setStatus("success");
	},

	emergencyRefund(batch: number) {
		if (now() <= state.absoluteEndTime + DEMO_EMERGENCY_GRACE)
			return this.setStatus("error", "The emergency window has not opened yet.");
		if (state.phase === 2) return this.setStatus("error", "The auction is already settled.");
		if (state.phase !== 3) {
			state.phase = 3;
			log("Emergency refund started. Settlement is locked out.");
		}
		this.refundAll(batch);
	},

	recoverSupplyMismatch() {
		// The demo has no external minter, so supply always matches (contract: SupplyNotMismatched).
		this.setStatus("error", "Supply matches. Mismatch recovery is not needed.");
	},

	// demo-only controls
	seedBid() {
		if (state.phase !== 0) return;
		const amount = minimumBid() + BigInt(rand(50)) * 1_000_000_000_000_000n;
		if (isFull()) {
			const low = lowestBid()!;
			state.bids = state.bids.filter((x) => x.id !== low.id);
			log(`Displaced #${low.id} (${fmt(low.amount)}) → refunded straight to ${short(low.bidder)}`);
		}
		state.bids.push({ id: nextId++, bidder: padAddr(seedCounter++), amount });
		maybeExtend();
		log(`Seeded competing bid ${fmt(amount)}`);
		emit();
	},

	fillToCapacity() {
		let guard = 0;
		while (state.bids.length < DEMO_MAX_UNITS && guard < 200) {
			const amount = DEMO_RESERVE + BigInt(rand(200)) * 1_000_000_000_000_000n;
			state.bids.push({ id: nextId++, bidder: padAddr(seedCounter++), amount });
			guard++;
		}
		log(`Filled to ${state.bids.length}/${DEMO_MAX_UNITS}`);
		emit();
	},
};

function short(a: string) {
	return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

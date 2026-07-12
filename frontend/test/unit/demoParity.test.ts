import { describe, expect, it } from "vitest";
import { bpsIncrement } from "@/app/auction/demo/demoStore";

/** Reference implementation of the contract's `_bpsIncrement` (ceiling division). */
function solidityBpsIncrement(amount: bigint, bps: bigint): bigint {
	return (amount * bps + 10_000n - 1n) / 10_000n;
}

describe("demo store parity with PanoramaSeason2Auction", () => {
	it("bpsIncrement matches the contract's ceiling math exactly", () => {
		const samples: bigint[] = [
			1n,
			2n,
			1_999n,
			10_000n,
			100_000_000_000_000_000n, // 0.1 ETH
			100_000_000_000_000_001n,
			333_333_333_333_333_333n,
			1_000_000_000_000_000_000n,
		];
		for (const amount of samples) {
			expect(bpsIncrement(amount, 500)).toBe(solidityBpsIncrement(amount, 500n));
		}
	});

	it("rounds UP where floor division would understate the advertised percentage", () => {
		// 1999 * 500 / 10000 = 99.95 -> ceil 100, floor 99. The contract requires 100.
		expect(bpsIncrement(1_999n, 500)).toBe(100n);
	});

	it("demo reserve equals the contract's MIN_RESERVE_PRICE floor (0.1 ETH)", async () => {
		const { DEMO_RESERVE } = await import("@/app/auction/demo/demoStore");
		expect(DEMO_RESERVE).toBe(100_000_000_000_000_000n);
	});
});

import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import {
	eth,
	ethCeil,
	ethExact,
	normalizeDecimalInput,
	parseBoundedIntegerInput,
	parseEthInput,
} from "@/lib/format";

const SAMPLES: bigint[] = [
	0n,
	1n,
	999n,
	1_000_000_000n,
	100_000_000_000_000_000n, // 0.1
	105_000_000_000_000_000n, // 0.105
	110_250_000_000_000_000n, // 0.11025
	122_000_000_000_000_001n,
	1_000_000_000_000_000_000n, // 1
	123_456_789_012_345_678_901n, // 123.45...
];

describe("ethExact", () => {
	it("round-trips through parseEther exactly", () => {
		for (const wei of SAMPLES) {
			expect(parseEther(ethExact(wei))).toBe(wei);
		}
	});

	it("always uses a dot decimal separator regardless of runtime locale", () => {
		for (const wei of SAMPLES) {
			expect(ethExact(wei)).not.toContain(",");
		}
	});
});

describe("eth (display)", () => {
	it("rounds half-up at the requested precision", () => {
		expect(eth(parseEther("0.1225"), 3)).toBe("0.123"); // 0.1225 -> .123
		expect(eth(parseEther("0.1224"), 3)).toBe("0.122");
		expect(eth(parseEther("1"), 3)).toBe("1");
		expect(eth(0n)).toBe("0");
	});

	it("never emits locale separators", () => {
		expect(eth(parseEther("1234.5678"))).toBe("1234.568");
	});
});

describe("ethCeil (never understates)", () => {
	it("parses back to a value >= the true amount, always", () => {
		for (const wei of SAMPLES) {
			if (wei === 0n) continue;
			for (const dp of [3, 4, 6]) {
				const shown = ethCeil(wei, dp);
				expect(parseEther(shown) >= wei).toBe(true);
			}
		}
	});

	it("shows the exact value when it fits in the precision", () => {
		expect(ethCeil(parseEther("0.105"), 4)).toBe("0.105");
		expect(ethCeil(parseEther("0.11025"), 4)).toBe("0.1103"); // rounded UP
	});
});

describe("normalizeDecimalInput", () => {
	it("turns comma decimals into dots (the 0,122 -> 122 ETH bug)", () => {
		expect(normalizeDecimalInput("0,122")).toBe("0.122");
		expect(parseEthInput("0,122")).toBe(parseEther("0.122"));
	});

	it("rejects multiple decimal separators instead of changing the amount", () => {
		expect(normalizeDecimalInput("1.2.3")).toBeNull();
		expect(normalizeDecimalInput("1,2,3")).toBeNull();
		expect(parseEthInput("1.2.3")).toBeNull();
	});

	it("rejects non-decimal syntax instead of stripping characters", () => {
		expect(normalizeDecimalInput("abc")).toBeNull();
		expect(normalizeDecimalInput("1e5")).toBeNull();
		expect(normalizeDecimalInput(" 0.5 eth")).toBeNull();
		expect(parseEthInput("1e5")).toBeNull();
	});

	it("never changes magnitude silently", () => {
		// The old filter stripped the comma: "0,122" -> "0122" -> 122 ETH.
		const parsed = parseEthInput("0,122");
		expect(parsed).not.toBe(parseEther("122"));
		expect(parsed).toBe(parseEther("0.122"));
	});
});

describe("parseEthInput", () => {
	it("returns null for empty or incomplete input", () => {
		expect(parseEthInput("")).toBeNull();
		expect(parseEthInput(".")).toBeNull();
		expect(parseEthInput("x")).toBeNull();
	});

	it("parses plain and partial decimals", () => {
		expect(parseEthInput("0.5")).toBe(parseEther("0.5"));
		expect(parseEthInput("2")).toBe(parseEther("2"));
		expect(parseEthInput("0.")).toBe(parseEther("0"));
	});
});

describe("parseBoundedIntegerInput", () => {
	it("accepts only a safe whole number inside the configured bounds", () => {
		expect(parseBoundedIntegerInput("1", 1, 60)).toBe(1);
		expect(parseBoundedIntegerInput("45", 1, 60)).toBe(45);
		expect(parseBoundedIntegerInput("60", 1, 60)).toBe(60);
	});

	it("rejects malformed, silently transformable, and out-of-range values", () => {
		for (const raw of ["", "0", "61", "1e2", "1.5", "1 5", "-1", "999999999999999999999"]) {
			expect(parseBoundedIntegerInput(raw, 1, 60)).toBeNull();
		}
	});
});

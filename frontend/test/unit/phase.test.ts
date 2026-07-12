import { describe, expect, it } from "vitest";
import { displayPhase } from "@/lib/phase";

const START = 1_800_000_000;
const END = START + 48 * 3600;

describe("displayPhase", () => {
	it("reports upcoming before startTime", () => {
		expect(displayPhase("active", START - 1, START, END)).toBe("upcoming");
	});

	it("reports live from startTime up to endTime", () => {
		expect(displayPhase("active", START, START, END)).toBe("active");
		expect(displayPhase("active", END - 1, START, END)).toBe("active");
	});

	it("reports closed once endTime passes", () => {
		expect(displayPhase("active", END, START, END)).toBe("closed");
		expect(displayPhase("active", END + 3600, START, END)).toBe("closed");
	});

	it("keeps the raw phase until the chain clock is known", () => {
		expect(displayPhase("active", 0, START, END)).toBe("active");
	});

	it("keeps the raw phase while the schedule is unloaded", () => {
		expect(displayPhase("active", START, 0, 0)).toBe("active");
	});

	it("never rewrites non-active phases", () => {
		expect(displayPhase("finalizing", END + 1, START, END)).toBe("finalizing");
		expect(displayPhase("settled", START - 1, START, END)).toBe("settled");
		expect(displayPhase("cancelled", START - 1, START, END)).toBe("cancelled");
	});
});

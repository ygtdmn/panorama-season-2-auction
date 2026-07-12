import { describe, expect, it } from "vitest";
import { assessWonLogIntegrity } from "@/lib/wonLogIntegrity";

describe("winner log integrity", () => {
	it("accepts the exact sequential minted prefix", () => {
		expect(
			assessWonLogIntegrity({
				phase: "finalizing",
				finalizeCursor: 3,
				winnerCount: 5,
				firstTokenId: 91,
				tokenIds: [91, 92, 93],
			}),
		).toMatchObject({ valid: true, expected: 3, actual: 3, issue: null });
	});

	it("rejects missing winner events", () => {
		const result = assessWonLogIntegrity({
			phase: "finalizing",
			finalizeCursor: 3,
			winnerCount: 5,
			firstTokenId: 91,
			tokenIds: [91, 92],
		});
		expect(result.valid).toBe(false);
		expect(result.issue).toContain("2 of 3");
	});

	it("rejects a malformed prefix even when events are also missing", () => {
		const result = assessWonLogIntegrity({
			phase: "finalizing",
			finalizeCursor: 2,
			winnerCount: 3,
			firstTokenId: 91,
			tokenIds: [92],
		});
		expect(result.valid).toBe(false);
		expect(result.issue).toContain("not sequential");
	});

	it("rejects duplicate, skipped, or out-of-order token ids", () => {
		for (const tokenIds of [[91, 91], [91, 93], [92, 91]]) {
			expect(
				assessWonLogIntegrity({
					phase: "finalizing",
					finalizeCursor: 2,
					winnerCount: 2,
					firstTokenId: 91,
					tokenIds,
				}).valid,
			).toBe(false);
		}
	});

	it("requires a settled cursor to equal the frozen winner count", () => {
		const result = assessWonLogIntegrity({
			phase: "settled",
			finalizeCursor: 2,
			winnerCount: 3,
			firstTokenId: 91,
			tokenIds: [91, 92],
		});
		expect(result.valid).toBe(false);
		expect(result.issue).toContain("only 2 of 3");
	});

	it("accepts a genuine zero-bid terminal auction", () => {
		expect(
			assessWonLogIntegrity({
				phase: "settled",
				finalizeCursor: 0,
				winnerCount: 0,
				firstTokenId: 91,
				tokenIds: [],
			}).valid,
		).toBe(true);
	});
});

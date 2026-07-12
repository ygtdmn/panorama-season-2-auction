export type SettlementPhase = "active" | "finalizing" | "settled" | "cancelled";

export interface WonLogIntegrityInput {
	phase: SettlementPhase;
	finalizeCursor: number;
	winnerCount: number;
	firstTokenId: number;
	tokenIds: readonly number[];
}

export interface WonLogIntegrity {
	expected: number;
	actual: number;
	valid: boolean;
	issue: string | null;
}

/**
 * Cross-check event-derived outcomes against contract accounting. A final board is authoritative
 * only when every minted cursor position has exactly one sequential Won event.
 */
export function assessWonLogIntegrity(input: WonLogIntegrityInput): WonLogIntegrity {
	const { phase, finalizeCursor, winnerCount, firstTokenId, tokenIds } = input;
	const expected = finalizeCursor;
	const actual = tokenIds.length;

	if (finalizeCursor < 0 || winnerCount < 0 || finalizeCursor > winnerCount) {
		return {
			expected,
			actual,
			valid: false,
			issue: `Settlement counters disagree (${finalizeCursor}/${winnerCount}).`,
		};
	}
	if (phase === "settled" && finalizeCursor !== winnerCount) {
		return {
			expected,
			actual,
			valid: false,
			issue: `Settled state reports only ${finalizeCursor} of ${winnerCount} winners minted.`,
		};
	}
	for (let i = 0; i < tokenIds.length; i++) {
		const expectedTokenId = firstTokenId + i;
		if (tokenIds[i] !== expectedTokenId) {
			return {
				expected,
				actual,
				valid: false,
				issue: `Winner history is not sequential at token ${expectedTokenId}.`,
			};
		}
	}
	if (actual !== expected) {
		return {
			expected,
			actual,
			valid: false,
			issue: `Winner history has ${actual} of ${expected} expected events.`,
		};
	}

	return { expected, actual, valid: true, issue: null };
}

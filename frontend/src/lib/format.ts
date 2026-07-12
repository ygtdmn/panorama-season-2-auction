// Locale-independent number handling for the auction.
//
// Two hard rules, both learned the expensive way:
// 1. Anything a user might SUBMIT must round-trip exactly: wei -> string -> parseEther -> same wei.
//    Only `ethExact` satisfies that. Display formatters are for reading, never for submitting.
// 2. No `toLocaleString`. In comma-decimal locales it produces "0,122", which either fails to
//    parse or, with a comma-stripping filter, silently becomes 122 ETH.

import { formatEther, parseEther } from "viem";

const WEI_DP = 18;

/** Exact wei -> decimal ETH string (dot separator, full precision). Safe to feed into parseEther. */
export function ethExact(wei: bigint): string {
	return formatEther(wei);
}

function applyDp(units: bigint, dp: number): string {
	const base = 10n ** BigInt(dp);
	const int = units / base;
	const frac = (units % base).toString().padStart(dp, "0").replace(/0+$/, "");
	return `${int}${frac ? `.${frac}` : ""}`;
}

/**
 * Display formatter: rounds half-up to `dp` decimals, trims trailing zeros, always a dot decimal.
 * Reading only. A rounded value can be BELOW the true amount, so never submit it.
 */
export function eth(wei: bigint, dp = 3): string {
	if (wei === 0n) return "0";
	const scale = 10n ** BigInt(WEI_DP - dp);
	return applyDp((wei + scale / 2n) / scale, dp);
}

/**
 * Display formatter that never understates: rounds UP to `dp` decimals. Use for minimums,
 * thresholds, and anything where "type what you see" must satisfy the contract.
 */
export function ethCeil(wei: bigint, dp = 4): string {
	if (wei === 0n) return "0";
	const scale = 10n ** BigInt(WEI_DP - dp);
	return applyDp((wei + scale - 1n) / scale, dp);
}

/**
 * Normalize a syntactically valid free-typed decimal input. Comma decimal separators become dots
 * (a German or Turkish keyboard types "0,15" for 0.15). Malformed input is REJECTED instead of
 * stripping characters or joining multiple decimal groups: `1e5`, `1.2.3`, and `0.5 ETH` must
 * never silently become a different amount.
 */
export function normalizeDecimalInput(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === "") return "";
	if (!/^\d*(?:[.,]\d*)?$/.test(trimmed)) return null;
	return trimmed.replace(",", ".");
}

/** Parse user input into wei. Returns null for empty or unparseable input. */
export function parseEthInput(raw: string): bigint | null {
	const normalized = normalizeDecimalInput(raw);
	if (normalized == null || !normalized || normalized === ".") return null;
	try {
		return parseEther(normalized);
	} catch {
		return null;
	}
}

/** Strict bounded integer parser for operational batch sizes. Never strips invalid characters. */
export function parseBoundedIntegerInput(raw: string, minimum: number, maximum: number): number | null {
	if (!/^\d+$/.test(raw)) return null;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return null;
	return value;
}

export function short(a: string): string {
	return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Deterministic UTC timestamp (no locale/hydration drift). */
export function fmtDateUTC(sec: number): string {
	if (!sec) return "";
	const d = new Date(sec * 1000);
	const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
		d.getUTCMonth()
	];
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${mon} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

"use client";

import { useSyncExternalStore } from "react";
import type { DisplayPhase } from "@/lib/phase";

// Locale-independent formatters live in lib/format (pure, unit-tested).
// Re-exported here so components keep a single import site.
export { eth, ethCeil, ethExact, fmtDateUTC, normalizeDecimalInput, parseEthInput, short } from "@/lib/format";
export { displayPhase } from "@/lib/phase";
export type { DisplayPhase } from "@/lib/phase";

/** Current unix seconds by the DEVICE clock, ticking every second. 0 during SSR/first paint. */
export function useNow(intervalMs = 1000): number {
	return useSyncExternalStore(
		(cb) => {
			const t = setInterval(cb, intervalMs);
			return () => clearInterval(t);
		},
		() => Math.floor(Date.now() / 1000),
		() => 0,
	);
}

export interface ChainTimeAnchor {
	/** Latest block timestamp, unix seconds. */
	timestamp: number;
	/** Device Date.now() in ms when that block was observed. */
	atMs: number;
}

/**
 * Chain-anchored clock: latest block timestamp plus seconds elapsed since it arrived.
 * The device clock only supplies the short delta since the last block, so a wrong system
 * clock cannot show "Ended" while the contract still accepts bids (or the reverse).
 * Returns 0 until the first block is observed (matches useNow's SSR behavior).
 */
export function useChainNow(anchor?: ChainTimeAnchor): number {
	const deviceNow = useNow();
	if (!deviceNow || !anchor || anchor.timestamp <= 0) return 0;
	const elapsed = Math.max(0, deviceNow - Math.floor(anchor.atMs / 1000));
	return anchor.timestamp + elapsed;
}

const DOT: Record<DisplayPhase, string> = {
	upcoming: "var(--muted)",
	active: "var(--up)",
	closed: "var(--muted)",
	finalizing: "var(--foreground)",
	settled: "var(--muted)",
	cancelled: "var(--signal)",
};

/** Small status dot; breathes only while bidding is actually open. */
export function LiveDot({ phase }: { phase: DisplayPhase }) {
	return (
		<span
			aria-hidden
			className="inline-block w-[7px] h-[7px] rounded-full shrink-0"
			style={{
				background: DOT[phase],
				animation: phase === "active" ? "breathe 2.4s var(--ease-out) infinite" : undefined,
			}}
		/>
	);
}

/** Micro uppercase mono label. */
export function Label({ children, className = "" }: { children: React.ReactNode; className?: string }) {
	return (
		<span className={`font-mono text-micro uppercase tracking-[0.14em] text-muted ${className}`}>
			{children}
		</span>
	);
}

/** Label + large serif figure with a small unit. */
export function Figure({
	label,
	value,
	unit,
	sub,
	size = "lg",
}: {
	label: string;
	value: string;
	unit?: string;
	sub?: React.ReactNode;
	size?: "sm" | "lg" | "xl";
}) {
	const sizeClass = size === "xl" ? "text-2xl" : size === "sm" ? "text-lg" : "text-xl";
	return (
		<div className="flex flex-col gap-1.5">
			<Label>{label}</Label>
			<div className="flex items-baseline gap-1.5">
				<span
					className={`font-serif font-medium tabular-nums tracking-[-0.01em] text-foreground leading-none ${sizeClass}`}
				>
					{value}
				</span>
				{unit && <span className="font-mono text-xs uppercase tracking-[0.12em] text-muted">{unit}</span>}
			</div>
			{sub && <div className="font-mono text-micro uppercase tracking-[0.12em] text-faint">{sub}</div>}
		</div>
	);
}

/** Thin capacity bar. Count is presented by the caller. */
export function Meter({ filled, total }: { filled: number; total: number }) {
	const pct = total > 0 ? Math.min(100, (filled / total) * 100) : 0;
	return (
		<div className="relative h-[3px] w-full bg-line overflow-hidden">
			<div
				className="absolute inset-y-0 left-0 bg-foreground transition-[width] duration-500"
				style={{ width: `${pct}%`, transitionTimingFunction: "var(--ease-out)" }}
			/>
		</div>
	);
}

"use client";

import { useEffect, useRef } from "react";
import { LuX } from "react-icons/lu";

const STEPS: { n: string; t: string; d: string }[] = [
	{
		n: "01",
		t: "The top ninety win",
		d: "Every bid is ranked from highest to lowest. The ninety highest are in; anything below the ninetieth is out.",
	},
	{
		n: "02",
		t: "Everyone pays the same price",
		d: "At close, every winner pays the ninetieth-highest bid, called the clearing price, no matter what they bid. Anything above it is refunded when the sale settles.",
	},
	{
		n: "03",
		t: "Higher bids reveal first",
		d: "Rank sets reveal order. The highest bid takes #1 and reveals on day one; each rank down reveals a day later, one painting per day.",
	},
	{
		n: "04",
		t: "Outbid means refunded at once",
		d: "The moment a higher bid pushes you below the top ninety, your ETH returns to your wallet. Nothing to claim, no waiting.",
	},
];

/** Explains the board mechanics. Self-contained: Escape / backdrop / close all dismiss. */
export function StandingsInfoModal({ onClose }: { onClose: () => void }) {
	const panelRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		const raf = window.requestAnimationFrame(() => closeRef.current?.focus());
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			window.cancelAnimationFrame(raf);
			document.removeEventListener("keydown", onKey);
			document.body.style.overflow = prevOverflow;
		};
	}, [onClose]);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="standings-info-heading"
			className="fixed inset-0 z-[200] flex items-center justify-center px-4"
			onClick={(e) => {
				if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
			}}
		>
			<div className="absolute inset-0 bg-black/60 animate-[backdrop-fade-in_200ms_var(--ease-out)]" aria-hidden="true" />
			<div
				ref={panelRef}
				tabIndex={-1}
				className="relative w-full max-w-[460px] max-h-[85vh] overflow-y-auto overlay-scroll-content bg-background border border-line animate-modal-in"
			>
				<div className="sticky top-0 bg-background flex items-center justify-between px-5 py-4 border-b border-line">
					<h2
						id="standings-info-heading"
						className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground"
					>
						How standings work
					</h2>
					<button
						ref={closeRef}
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="text-muted hover:text-foreground transition-colors cursor-pointer"
					>
						<LuX size={16} strokeWidth={1.5} />
					</button>
				</div>

				<ol className="px-5 py-5 flex flex-col divide-y divide-line">
					{STEPS.map((s) => (
						<li key={s.n} className="flex gap-4 py-4 first:pt-0 last:pb-0">
							<span className="font-mono text-micro tabular-nums text-faint pt-1 w-6 shrink-0">
								{s.n}
							</span>
							<div className="flex flex-col gap-1.5">
								<h3 className="font-serif font-medium text-lg text-foreground leading-snug">
									{s.t}
								</h3>
								<p className="font-sans text-sm text-muted leading-relaxed">{s.d}</p>
							</div>
						</li>
					))}
				</ol>
			</div>
		</div>
	);
}

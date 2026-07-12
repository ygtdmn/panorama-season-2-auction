"use client";

import { useState } from "react";
import type { DemoControls } from "../hooks/useAuctionSession";
import { DEMO_SCENARIOS } from "../demo/demoStore";

const CHIP =
	"font-mono text-micro uppercase tracking-[0.14em] border border-line px-3 py-2 text-foreground hover:border-foreground active:translate-y-px transition-all duration-200 cursor-pointer";
const STATE_CHIP =
	"font-mono text-micro uppercase tracking-[0.12em] border border-line px-2.5 py-1.5 text-muted hover:border-foreground hover:text-foreground active:translate-y-px transition-all duration-200 cursor-pointer";

function short(a: string) {
	return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function DemoBar({ controls, showControls = true }: { controls: DemoControls; showControls?: boolean }) {
	const [showLog, setShowLog] = useState(false);
	return (
		<div className="border border-signal/40 bg-signal/[0.04] p-4 mb-6">
			<div className="flex flex-wrap items-center gap-3 justify-between">
				<div className="flex items-center gap-3">
					<span className="font-mono text-[10px] uppercase tracking-[0.2em] text-signal">Demo mode</span>
					<span className="font-mono text-[10px] text-muted">
						in-memory / resets on reload / not on-chain
					</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted">you</span>
					<button className={CHIP} onClick={controls.switchIdentity} title="switch demo identity">
						{short(controls.you)} / switch
					</button>
					{controls.won > 0 && (
						<span className="font-mono text-[10px] uppercase tracking-[0.15em] text-up">
							won {controls.won}
						</span>
					)}
				</div>
			</div>

			{showControls && (
				<>
					<div className="flex flex-wrap items-center gap-2 mt-3">
						<button className={CHIP} onClick={controls.seedBid}>
							+ competing bid
						</button>
						<button className={CHIP} onClick={controls.fillToCapacity}>
							fill to 90
						</button>
						<button className={CHIP} onClick={controls.endNow}>
							end auction
						</button>
						<button className={CHIP} onClick={controls.reset}>
							reset
						</button>
						<button className={CHIP} onClick={() => setShowLog((v) => !v)}>
							{showLog ? "hide log" : "show log"}
						</button>
					</div>

					{/* Jump straight to any UI state. */}
					<div className="flex flex-wrap items-center gap-1.5 mt-3 pt-3 border-t border-line/60">
						<span className="font-mono text-micro uppercase tracking-[0.15em] text-faint mr-1">
							view state
						</span>
						{DEMO_SCENARIOS.map((sc) => (
							<button
								key={sc.key}
								className={STATE_CHIP}
								onClick={() => controls.jumpTo(sc.key)}
							>
								{sc.label}
							</button>
						))}
					</div>
				</>
			)}

			{showLog && (
				<div className="mt-3 max-h-40 overflow-y-auto border border-line p-2 flex flex-col gap-1">
					{controls.log.length === 0 ? (
						<span className="font-mono text-[10px] text-faint">no events yet</span>
					) : (
						controls.log.map((line, i) => (
							<span key={i} className="font-mono text-[10px] text-muted">
								{line}
							</span>
						))
					)}
				</div>
			)}
		</div>
	);
}

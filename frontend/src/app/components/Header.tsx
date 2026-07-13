"use client";

import { LuMoon, LuSun } from "react-icons/lu";
import { SITE_URL } from "@/lib/constants";
import { useTheme } from "./ThemeProvider";

// The header row sits 40px down from the viewport top, is 24px tall.
export const HEADER_TOP = 40;
export const HEADER_ROW = 24;
export const HEADER_HEIGHT = HEADER_TOP + HEADER_ROW;

const TYPE = "font-mono text-[12px] uppercase tracking-[0.2em] tabular-nums cursor-pointer";

// Minimal fixed header for the standalone auction app, styled to match the main
// Panorama site chrome. Left: PANORAMA SEASON 2. Right: color mode toggle.
export default function Header() {
	const { toggle } = useTheme();
	return (
		<>
			{/* Solid mask so page content scrolling underneath the fixed header stays clean. */}
			<div
				aria-hidden
				className="fixed top-0 left-0 right-0 z-40 bg-background"
				style={{ height: HEADER_TOP + HEADER_ROW }}
			/>
			<div
				className="fixed left-0 right-0 z-50 flex items-center justify-between select-none gap-6 px-5 md:px-10 4xl:px-16"
				style={{ top: HEADER_TOP, height: HEADER_ROW }}
			>
			<div className="flex items-center min-w-0 whitespace-nowrap" style={{ gap: 10 }}>
				<a href={SITE_URL} className={`${TYPE} text-foreground`}>
					PANORAMA
				</a>
				<span className={`${TYPE} text-foreground/75 hidden sm:inline`}>SEASON 2</span>
			</div>

			<div className="flex items-center whitespace-nowrap" style={{ gap: 10 }}>
				<button
					type="button"
					onClick={toggle}
					aria-label="Toggle light / dark"
					className="text-foreground/75 hover:text-foreground transition-colors cursor-pointer leading-none"
				>
					{/* Icon is driven by the .dark class (set pre-hydration) — no state, no flicker. */}
					<LuSun size={14} className="hidden dark:block" />
					<LuMoon size={14} className="block dark:hidden" />
				</button>
			</div>
			</div>
		</>
	);
}

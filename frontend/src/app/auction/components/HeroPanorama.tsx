"use client";

import { useRef } from "react";
import { CDN_BASE_URL } from "@/lib/constants";

// Demo header: five paintings in the new Season 2 art style, shown as one scrollable strip so
// people can get a feel for the work. Served from the CDN.
const IMAGES = [1, 2, 3, 4, 5].map(
	(n) => `${CDN_BASE_URL}/season2/header/${n}.webp`,
);

/**
 * The panorama as a full-width, horizontally scrollable band — the same left-to-right read as
 * the main canvas. Mouse users drag to pan; touch and trackpad use native horizontal scrolling.
 */
export function HeroPanorama() {
	const scrollerRef = useRef<HTMLDivElement>(null);

	// Drag-to-pan for mouse only; touch/trackpad keep native horizontal scrolling, and vertical
	// intent is left alone so the page can still scroll.
	const drag = useRef({ down: false, panning: false, startX: 0, startY: 0, startLeft: 0, pointerId: -1 });
	const onPointerDown = (e: React.PointerEvent) => {
		if (e.pointerType !== "mouse") return;
		const el = scrollerRef.current;
		if (!el) return;
		drag.current = {
			down: true,
			panning: false,
			startX: e.clientX,
			startY: e.clientY,
			startLeft: el.scrollLeft,
			pointerId: e.pointerId,
		};
	};
	const onPointerMove = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d.down) return;
		const el = scrollerRef.current;
		if (!el) return;
		const dx = e.clientX - d.startX;
		const dy = e.clientY - d.startY;
		if (!d.panning) {
			if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 6) {
				d.down = false; // vertical intent → let the page scroll
				return;
			}
			if (Math.abs(dx) > 6) {
				d.panning = true;
				el.setPointerCapture?.(d.pointerId);
			}
		}
		if (d.panning) el.scrollLeft = d.startLeft - dx;
	};
	const endDrag = (e: React.PointerEvent) => {
		const el = scrollerRef.current;
		if (drag.current.panning) el?.releasePointerCapture?.(e.pointerId);
		drag.current.down = false;
		drag.current.panning = false;
	};

	return (
		<div className="relative w-full h-full">
			<div
				ref={scrollerRef}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
				className="w-full h-full overflow-x-auto overflow-y-hidden select-none cursor-grab active:cursor-grabbing"
			>
				<div className="flex h-full w-max bg-surface">
					{IMAGES.map((url, i) => (
						/* eslint-disable-next-line @next/next/no-img-element */
						<img
							key={url}
							src={url}
							alt={i === 0 ? "A Panorama Season 2 painting" : ""}
							draggable={false}
							loading={i < 2 ? "eager" : "lazy"}
							className="block h-full w-auto pointer-events-none"
							style={{ aspectRatio: "16 / 9" }}
						/>
					))}
				</div>
			</div>

			{IMAGES.length > 1 && (
				<div className="pointer-events-none absolute bottom-3 right-4 md:right-6 font-mono text-micro uppercase tracking-[0.18em] text-background/80 mix-blend-difference">
					Drag to explore →
				</div>
			)}
		</div>
	);
}

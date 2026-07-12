"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_DELAY_MS = 400;
const VIEWPORT_GAP_PX = 8;
const ANCHOR_GAP_PX = 8;

type TooltipSource = "focus" | "hover" | "tap";

interface TooltipState {
	anchor: HTMLElement;
	text: string;
	wrap: boolean;
	admin: boolean;
}

function tooltipAnchor(target: EventTarget | null): HTMLElement | null {
	return target instanceof Element
		? (target.closest<HTMLElement>("[data-tooltip]") ?? null)
		: null;
}

export function TooltipProvider() {
	const [tooltip, setTooltip] = useState<TooltipState | null>(null);
	const tooltipElement = useRef<HTMLDivElement>(null);
	const tooltipState = useRef<TooltipState | null>(null);
	const source = useRef<TooltipSource | null>(null);
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const clearOpenTimer = () => {
			if (openTimer.current) {
				clearTimeout(openTimer.current);
				openTimer.current = null;
			}
		};

		const hide = (anchor?: HTMLElement) => {
			clearOpenTimer();
			if (source.current === "tap") return;
			if (anchor && tooltipState.current?.anchor !== anchor) return;
			source.current = null;
			tooltipState.current = null;
			setTooltip(null);
		};

		const show = (anchor: HTMLElement, nextSource: TooltipSource, delayed = false) => {
			const text = anchor.dataset.tooltip;
			if (!text || (source.current === "tap" && nextSource !== "tap")) {
				return;
			}

			clearOpenTimer();
			const commit = () => {
				const nextTooltip = {
					anchor,
					text,
					wrap: anchor.hasAttribute("data-tooltip-wrap"),
					admin: !!anchor.closest("[data-admin-root]"),
				};
				source.current = nextSource;
				tooltipState.current = nextTooltip;
				setTooltip(nextTooltip);
			};

			if (delayed) {
				openTimer.current = setTimeout(commit, TOOLTIP_DELAY_MS);
			} else {
				commit();
			}
		};

		const onMouseOver = (event: MouseEvent) => {
			const anchor = tooltipAnchor(event.target);
			if (!anchor) return;
			if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return;
			show(anchor, "hover", true);
		};

		const onMouseOut = (event: MouseEvent) => {
			const anchor = tooltipAnchor(event.target);
			if (!anchor) return;
			const nextTarget = event.relatedTarget;
			if (nextTarget instanceof Node && anchor.contains(nextTarget)) return;

			hide(anchor);
			const nextAnchor = tooltipAnchor(nextTarget);
			if (nextAnchor && nextAnchor !== anchor) show(nextAnchor, "hover", true);
		};

		const onFocusIn = (event: FocusEvent) => {
			const anchor = tooltipAnchor(event.target);
			if (anchor) show(anchor, "focus", true);
		};

		const onFocusOut = (event: FocusEvent) => {
			const anchor = tooltipAnchor(event.target);
			if (anchor) hide(anchor);
		};

		const onPointerDown = (event: PointerEvent) => {
			const anchor = tooltipAnchor(event.target);
			if (source.current === "tap" && tooltipState.current?.anchor !== anchor) {
				source.current = null;
				tooltipState.current = null;
				setTooltip(null);
			}

			if (
				event.pointerType === "mouse" ||
				!anchor?.hasAttribute("data-tooltip-tap")
			) {
				return;
			}

			if (source.current === "tap" && tooltipState.current?.anchor === anchor) {
				source.current = null;
				tooltipState.current = null;
				setTooltip(null);
			} else {
				show(anchor, "tap");
			}
		};

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || source.current !== "tap") return;
			source.current = null;
			tooltipState.current = null;
			setTooltip(null);
		};

		document.addEventListener("mouseover", onMouseOver);
		document.addEventListener("mouseout", onMouseOut);
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("focusout", onFocusOut);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			clearOpenTimer();
			document.removeEventListener("mouseover", onMouseOver);
			document.removeEventListener("mouseout", onMouseOut);
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("focusout", onFocusOut);
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, []);

	useLayoutEffect(() => {
		const element = tooltipElement.current;
		if (!tooltip || !element) return;

		const position = () => {
			if (!tooltip.anchor.isConnected) {
				source.current = null;
				tooltipState.current = null;
				setTooltip(null);
				return;
			}

			const anchorRect = tooltip.anchor.getBoundingClientRect();
			const tooltipRect = element.getBoundingClientRect();
			const maxLeft = Math.max(
				VIEWPORT_GAP_PX,
				window.innerWidth - tooltipRect.width - VIEWPORT_GAP_PX,
			);
			const centeredLeft = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;
			const left = Math.min(Math.max(centeredLeft, VIEWPORT_GAP_PX), maxLeft);
			const above = anchorRect.top - tooltipRect.height - ANCHOR_GAP_PX;
			const below = anchorRect.bottom + ANCHOR_GAP_PX;
			const maxTop = Math.max(
				VIEWPORT_GAP_PX,
				window.innerHeight - tooltipRect.height - VIEWPORT_GAP_PX,
			);
			const top =
				above >= VIEWPORT_GAP_PX
					? above
					: Math.min(Math.max(below, VIEWPORT_GAP_PX), maxTop);

			element.style.left = `${left}px`;
			element.style.top = `${top}px`;
			element.style.visibility = "visible";
		};

		position();
		window.addEventListener("resize", position);
		window.addEventListener("scroll", position, true);
		return () => {
			window.removeEventListener("resize", position);
			window.removeEventListener("scroll", position, true);
		};
	}, [tooltip]);

	if (!tooltip) return null;

	return createPortal(
		<div
			ref={tooltipElement}
			role="tooltip"
			className={`app-tooltip ${tooltip.wrap ? "app-tooltip--wrap" : ""} ${
				tooltip.admin ? "app-tooltip--admin" : ""
			}`}
		>
			{tooltip.text}
		</div>,
		document.body,
	);
}

// The bidding rail's persisted full-width preference.
//
// The layout must be maximized on the FIRST paint, not after hydration (a post-mount flip
// reads as a layout jump). Same approach as the theme: an inline script stamps
// `data-rail-max="1"` on <html> before anything renders, and globals.css drives the
// maximized layout off that attribute. React state only mirrors it for labels/icons.

export const RAIL_MAX_STORAGE_KEY = "panorama-auction:rail-max";

/** Runs before first paint (injected in layout.tsx next to the theme script). */
export const railMaxInitScript = `(function(){try{if(localStorage.getItem("${RAIL_MAX_STORAGE_KEY}")==="1")document.documentElement.setAttribute("data-rail-max","1")}catch(e){}})();`;

/** True when the pre-paint script (or a later toggle) marked the document maximized. */
export function readRailMaxAttribute(): boolean {
	return document.documentElement.getAttribute("data-rail-max") === "1";
}

/** Applies the preference to the document (drives the CSS) and persists it. */
export function applyRailMax(next: boolean): void {
	if (next) {
		document.documentElement.setAttribute("data-rail-max", "1");
	} else {
		document.documentElement.removeAttribute("data-rail-max");
	}
	try {
		window.localStorage.setItem(RAIL_MAX_STORAGE_KEY, next ? "1" : "0");
	} catch {
		// Storage may be unavailable in hardened/private contexts; the preference resets.
	}
}

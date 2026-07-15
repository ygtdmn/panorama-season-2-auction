// Server-safe home for the pre-paint theme bootstrap. layout.tsx (a server component) must
// not import this from ThemeProvider: importing a value from a "use client" module there
// yields a client-reference stub, and the inline script silently serializes to junk.

export const THEME_STORAGE_KEY = "panorama-auction-theme";

// Runs before hydration to set the .dark class and avoid a flash. Honors a stored
// preference, otherwise the device's prefers-color-scheme.
export const themeInitScript = `(function(){try{var k="${THEME_STORAGE_KEY}";var v=localStorage.getItem(k);var t=(v==="light"||v==="dark")?v:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.classList.toggle("dark",t==="dark");}catch(e){document.documentElement.classList.add("dark");}})();`;

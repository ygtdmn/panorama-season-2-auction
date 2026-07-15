"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";

import { THEME_STORAGE_KEY as STORAGE_KEY } from "@/lib/themeScript";

type ThemeContextValue = {
	theme: Theme;
	setTheme: (t: Theme) => void;
	toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue>({
	theme: "dark",
	setTheme: () => {},
	toggle: () => {},
});

function systemTheme(): Theme {
	if (typeof window === "undefined") return "dark";
	return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readStored(): Theme | null {
	try {
		const v = window.localStorage.getItem(STORAGE_KEY);
		return v === "light" || v === "dark" ? v : null;
	} catch {
		return null;
	}
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [theme, setThemeState] = useState<Theme>("dark");
	// Whether the user has explicitly chosen a theme (vs following the device).
	const [manual, setManual] = useState(false);

	// On mount: adopt the stored preference, otherwise the device setting.
	useEffect(() => {
		const stored = readStored();
		if (stored) {
			setManual(true);
			setThemeState(stored);
		} else {
			setThemeState(systemTheme());
		}
	}, []);

	// Reflect the theme onto <html>.
	useEffect(() => {
		document.documentElement.classList.toggle("dark", theme === "dark");
	}, [theme]);

	// Follow the device while the user hasn't overridden it.
	useEffect(() => {
		if (manual) return;
		const mq = window.matchMedia("(prefers-color-scheme: light)");
		const onChange = () => setThemeState(mq.matches ? "light" : "dark");
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, [manual]);

	const setTheme = useCallback((t: Theme) => {
		setManual(true);
		setThemeState(t);
		try {
			window.localStorage.setItem(STORAGE_KEY, t);
		} catch {}
	}, []);

	const toggle = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme, setTheme]);

	return <ThemeContext.Provider value={{ theme, setTheme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
	return useContext(ThemeContext);
}

// The pre-paint theme bootstrap lives in @/lib/themeScript (server-safe; layout.tsx must
// not import it from this "use client" module).

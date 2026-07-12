"use client";

import { useEffect, useState } from "react";
import { METADATA_INDEX_URL } from "@/lib/constants";
import { imageUrlFromDate } from "@/types/metadata";

// Full 1920×1080 painting (uncropped). Fallback is a known-good date; the hook
// swaps in the latest live painting once the metadata index loads.
// To pin a specific painting, replace this with imageUrlFromDate("YYYY-MM-DD", "optimized").
const FALLBACK = imageUrlFromDate("2026-07-09", "optimized");

interface IndexImage {
	date: string;
	timestamp: number;
}

/** The latest full panorama painting, for the auction hero. */
export function useHeroPainting(): string {
	const [url, setUrl] = useState(FALLBACK);

	useEffect(() => {
		let cancelled = false;
		fetch(METADATA_INDEX_URL)
			.then((r) => (r.ok ? r.json() : null))
			.then((idx: { images?: IndexImage[] } | null) => {
				const imgs = idx?.images;
				if (!cancelled && Array.isArray(imgs) && imgs.length > 0) {
					const latest = imgs.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
					if (latest?.date) setUrl(imageUrlFromDate(latest.date, "optimized"));
				}
			})
			.catch(() => {
				/* keep fallback */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return url;
}

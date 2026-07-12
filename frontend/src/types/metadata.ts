import { CDN_BASE_URL } from "@/lib/constants";

export interface Market {
	price: string; // decimal string with full precision (e.g. "0.170678334619567890")
	change: number;
}

export interface Images {
	full: string;
	optimized: string;
	thumbnail: string;
	preStitchFull?: string;
}

export interface Metadata {
	schemaVersion: 1;
	date: string;
	timestamp: number;
	dayNumber: number;
	market: Market;
	prompt: string;
	seed: number;
	mood: string;
	workflow: string;
	images: Images;
	tokenId?: number;
}

export interface IndexEntry {
	date: string;
	timestamp: number;
	dayNumber: number;
	metadataUrl: string;
}

// Base type for image items in the chart (IndexEntry + display URL)
export interface ImageItemBase extends IndexEntry {
	type: "image";
	url: string;
}

export interface MetadataIndex {
	schemaVersion: 1;
	lastUpdated: string;
	totalImages: number;
	images: IndexEntry[];
}

// Helper to construct CDN URLs from relative paths
export function cdnUrl(path: string): string {
	return `${CDN_BASE_URL}/${path}`;
}

// Helper to construct URLs from a date string
export function imageUrlFromDate(date: string, variant: "full" | "optimized" | "optimized_updated" | "thumbnail" | "thumbnail_updated" | "updated"): string {
	switch (variant) {
		case "full":
			return cdnUrl(`generated_${date}.jpg`);
		case "optimized":
			return cdnUrl(`optimized_${date}.webp`);
		case "optimized_updated":
			return cdnUrl(`optimized_updated_${date}.webp`);
		case "thumbnail":
			return cdnUrl(`thumbnail_${date}.webp`);
		case "thumbnail_updated":
			return cdnUrl(`thumbnail_updated_${date}.webp`);
		case "updated":
			return cdnUrl(`updated_${date}.jpg`);
	}
}

export function metadataUrlFromDate(date: string): string {
	return cdnUrl(`metadata_${date}.json`);
}

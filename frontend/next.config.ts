import type { NextConfig } from "next";
import { assertProductionEnv } from "./src/lib/env";

// Validate NEXT_PUBLIC_* values at build time: a malformed address or a missing
// production RPC/WalletConnect id fails the build here, not a collector's session.
assertProductionEnv();

// Extract hostname from CDN base URL env var for Next.js image optimization
const cdnUrl = process.env.NEXT_PUBLIC_CDN_BASE_URL || "https://cdn.panorama.garden";
const cdnHostname = new URL(cdnUrl).hostname;

const isDev = process.env.NODE_ENV !== "production";
// Plain-HTTP RPC is only a thing for local anvil (dev / e2e); production stays https-only.
const allowLocalRpc = isDev || process.env.NEXT_PUBLIC_CHAIN_ID === "31337";

// A dapp needs to reach user-chosen RPCs and the WalletConnect relay, so connect-src stays
// broad (https/wss). Everything else is locked down. `unsafe-inline` for scripts is required
// by Next's app-router bootstrap; `unsafe-eval` only in dev (react-refresh).
const csp = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https:",
	"font-src 'self' data:",
	`connect-src 'self' https: wss:${allowLocalRpc ? " http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*" : ""}`,
	"frame-src https://verify.walletconnect.com https://verify.walletconnect.org",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
	devIndicators: false,
	async redirects() {
		return [
			// The auction is the whole app and now lives at the root. Keep the old
			// /auction path working for anyone with a bookmark or shared link.
			{ source: "/auction", destination: "/", permanent: false },
		];
	},
	images: {
		remotePatterns: [
			{ protocol: "https", hostname: cdnHostname, port: "", pathname: "/**", search: "" },
		],
	},
	async headers() {
		return [
			{
				source: "/(.*)",
				headers: [
					{ key: "Content-Security-Policy", value: csp },
					{ key: "X-Frame-Options", value: "DENY" },
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
					{ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
				],
			},
			{
				// Belt and braces on top of the admin layout's robots metadata.
				source: "/admin",
				headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
			},
		];
	},
};

export default nextConfig;

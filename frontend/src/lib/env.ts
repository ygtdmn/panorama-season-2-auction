// Typed environment validation. Imported by next.config.ts, so a malformed or missing
// production value fails the BUILD instead of a collector's session mid-auction.
//
// NEXT_PUBLIC_* values are inlined at build time; every access below must therefore spell
// out the full `process.env.NEXT_PUBLIC_X` form (no dynamic lookups) so Next can inline it.

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DIGITS_RE = /^\d+$/;

export class EnvError extends Error {
	constructor(message: string) {
		super(`[env] ${message}`);
	}
}

function address(name: string, value: string | undefined): `0x${string}` | "" {
	if (!value) return "";
	if (!ADDRESS_RE.test(value)) throw new EnvError(`${name} is not a valid 0x address: "${value}"`);
	return value as `0x${string}`;
}

export function validateRpcUrl(
	value: string | undefined,
	chainId: 1 | 11155111 | 31337,
): string {
	if (!value) return "";
	try {
		const u = new URL(value);
		// wagmi is configured with http(), not webSocket(); accepting wss here produces a broken
		// transport that looks valid at build time. Plain HTTP is reserved for loopback anvil.
		if (u.protocol === "wss:" || u.protocol === "ws:") {
			throw new EnvError(
				"NEXT_PUBLIC_RPC_URL must use an HTTP transport URL, not ws/wss.",
			);
		}
		if (chainId === 31337) {
			if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
			if (u.protocol === "http:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
				throw new EnvError(
					"plain-http NEXT_PUBLIC_RPC_URL is only allowed for local anvil (localhost/127.0.0.1).",
				);
			}
		} else if (u.protocol !== "https:") {
			throw new EnvError(
				"NEXT_PUBLIC_RPC_URL must use https on mainnet and sepolia.",
			);
		}
		return value;
	} catch (error) {
		if (error instanceof EnvError) throw error;
		throw new EnvError(`NEXT_PUBLIC_RPC_URL is not a valid RPC URL: "${value}"`);
	}
}

function uint(name: string, value: string | undefined, fallback: bigint): bigint {
	if (!value) return fallback;
	if (!DIGITS_RE.test(value)) throw new EnvError(`${name} must be a plain integer: "${value}"`);
	return BigInt(value);
}

const chainIdRaw = process.env.NEXT_PUBLIC_CHAIN_ID ?? "1";
if (chainIdRaw !== "1" && chainIdRaw !== "11155111" && chainIdRaw !== "31337") {
	throw new EnvError(
		`NEXT_PUBLIC_CHAIN_ID must be 1 (mainnet), 11155111 (sepolia), or 31337 (local anvil); got "${chainIdRaw}"`,
	);
}

export const ENV = {
	chainId: Number(chainIdRaw) as 1 | 11155111 | 31337,
	rpcUrl: validateRpcUrl(
		process.env.NEXT_PUBLIC_RPC_URL,
		Number(chainIdRaw) as 1 | 11155111 | 31337,
	),
	walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
	auctionAddress: address(
		"NEXT_PUBLIC_PANORAMA_AUCTION_ADDRESS",
		process.env.NEXT_PUBLIC_PANORAMA_AUCTION_ADDRESS,
	),
	nftAddress: address("NEXT_PUBLIC_PANORAMA_NFT_ADDRESS", process.env.NEXT_PUBLIC_PANORAMA_NFT_ADDRESS),
	auctionDeployBlock: uint(
		"NEXT_PUBLIC_AUCTION_DEPLOY_BLOCK",
		process.env.NEXT_PUBLIC_AUCTION_DEPLOY_BLOCK,
		0n,
	),
	demo: process.env.NEXT_PUBLIC_AUCTION_DEMO === "1",
} as const;

/**
 * Hard build-time requirements for the real production deployment. Called from next.config.ts.
 * Strict mode arms when the deploy platform marks the build as production
 * (VERCEL_ENV=production, or PANORAMA_PRODUCTION=1 anywhere else) and the app targets mainnet.
 * Local, CI, sepolia, and demo builds only get the format validation above.
 */
export function assertProductionEnv(): void {
	const platformProd =
		process.env.VERCEL_ENV === "production" || process.env.PANORAMA_PRODUCTION === "1";
	const prod = platformProd && ENV.chainId === 1 && !ENV.demo;
	if (!prod) return;

	const problems: string[] = [];
	if (!ENV.rpcUrl) {
		problems.push(
			"NEXT_PUBLIC_RPC_URL is required in production: without it every visitor rides rate-limited public RPCs and the bidding UI goes stale in the endgame.",
		);
	}
	if (!ENV.walletConnectProjectId) {
		problems.push(
			"NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is required in production: without it mobile wallets cannot connect.",
		);
	}
	if (ENV.auctionAddress && ENV.auctionDeployBlock === 0n) {
		problems.push(
			"NEXT_PUBLIC_AUCTION_DEPLOY_BLOCK is required with NEXT_PUBLIC_PANORAMA_AUCTION_ADDRESS: winner history cannot be trusted or queried efficiently without its canonical lower bound.",
		);
	}
	if (!ENV.auctionAddress) {
		console.warn(
			"[env] NEXT_PUBLIC_PANORAMA_AUCTION_ADDRESS is unset; the site will render the pre-launch screen.",
		);
	}
	if (problems.length) {
		throw new EnvError(`production build blocked:\n- ${problems.join("\n- ")}`);
	}
}

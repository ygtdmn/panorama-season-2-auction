// Centralized constants — single source of truth for URLs and config

import { ENV } from "./env";

export const CDN_BASE_URL =
	process.env.NEXT_PUBLIC_CDN_BASE_URL ||
	"https://cdn.panorama.garden";

// Validated against the configured chain in env.ts; the default follows the chain too, so
// a sepolia build never links bidders to mainnet Etherscan pages that cannot show their txs.
export const BLOCK_EXPLORER_URL =
	ENV.blockExplorerUrl ||
	(ENV.chainId === 11155111 ? "https://sepolia.etherscan.io" : "https://etherscan.io");

export const PANORAMA_ERC20_ADDRESS = (process.env
	.NEXT_PUBLIC_PANORAMA_ERC20_ADDRESS || "") as `0x${string}`;

export const OPENSEA_COLLECTION_SLUG = "panorama-by-ygtdmn";
export const OPENSEA_COLLECTION_URL = `https://opensea.io/collection/${OPENSEA_COLLECTION_SLUG}`;

// The main Panorama site (links out to the canvas, terminal, about pages).
export const SITE_URL = "https://panorama.garden";

// This app's own public origin. Used wherever the site identifies itself: WalletConnect
// metadata, Open Graph canonical URLs. Must match the deployed host, or wallets show a
// mismatched origin during connection prompts.
export const AUCTION_SITE_URL = "https://season2.panorama.garden";

// Public source + on-chain code links, so anyone can read the contract before bidding.
export const GITHUB_URL =
	process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/ygtdmn/panorama";

// The published security review (public edition), linked from the FAQ and footer.
export const AUDIT_REPORT_URL =
	"https://github.com/ygtdmn/panorama-season-2-auction/blob/main/Audit.pdf";

/** evm.now shows a contract's verified/decompiled source by address. */
export function getEvmNowUrl(address: string): string {
	return `https://evm.now/${address}`;
}

export const OG_IMAGE_URL = `${CDN_BASE_URL}/season2/season2-og-preview.webp`;

export function getBlockExplorerAddressUrl(address: string): string {
	return `${BLOCK_EXPLORER_URL}/address/${address}`;
}

export function getBlockExplorerTxUrl(hash: string): string {
	return `${BLOCK_EXPLORER_URL}/tx/${hash}`;
}

export const PREREVEAL_IMAGE_URL = `${CDN_BASE_URL}/season2/season2-prereveal.webp`;

export function getDemoImageUrl(index: number): string {
	return `${CDN_BASE_URL}/demo${index}.jpg`;
}

export const PANORAMA_NFT_ADDRESS = (process.env
	.NEXT_PUBLIC_PANORAMA_NFT_ADDRESS || "") as `0x${string}`;

export const PANORAMA_STORAGE_ADDRESS = (process.env
	.NEXT_PUBLIC_PANORAMA_STORAGE_ADDRESS || "") as `0x${string}`;

export const PANORAMA_RENDERER_ADDRESS = (process.env
	.NEXT_PUBLIC_PANORAMA_RENDERER_ADDRESS || "") as `0x${string}`;

export const PANORAMA_MINT_CONTROLLER_ADDRESS = (process.env
	.NEXT_PUBLIC_PANORAMA_MINT_CONTROLLER_ADDRESS || "") as `0x${string}`;

export const PANORAMA_MURI_OPERATOR_ADDRESS = (process.env
	.NEXT_PUBLIC_PANORAMA_MURI_OPERATOR_ADDRESS || "") as `0x${string}`;

export const PANORAMA_AUCTION_ADDRESS = (process.env
	.NEXT_PUBLIC_PANORAMA_AUCTION_ADDRESS || "") as `0x${string}`;

// Block the auction contract was deployed at. Bounds the Won-event log scan that powers the
// settlement standings; 0 means "from genesis" (works, but slow on some RPC providers).
export const AUCTION_DEPLOY_BLOCK = BigInt(
	process.env.NEXT_PUBLIC_AUCTION_DEPLOY_BLOCK || "0",
);

export const MURI_PROTOCOL_ADDRESS =
	"0x0000000000C2A0B63ab4aA971B08B905E5875b01" as `0x${string}`;

export const LIQUID_ROUTER_ADDRESS = (process.env.NEXT_PUBLIC_LIQUID_ROUTER_ADDRESS ||
	"0xebd58eda8408d9ea409f2c2be8898bd9738f3583") as `0x${string}`;

export const V4_QUOTER_ADDRESS = (process.env.NEXT_PUBLIC_V4_QUOTER_ADDRESS ||
	"0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203") as `0x${string}`;

export const WETH_ADDRESS = (process.env.NEXT_PUBLIC_WETH_ADDRESS ||
	"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2") as `0x${string}`;

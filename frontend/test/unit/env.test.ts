import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, validateBlockExplorerUrl, validateRpcUrl } from "@/lib/env";

describe("RPC URL validation", () => {
	it("requires HTTPS for mainnet and sepolia", () => {
		expect(validateRpcUrl("https://rpc.example", 1)).toBe("https://rpc.example");
		expect(validateRpcUrl("https://rpc.example", 11155111)).toBe("https://rpc.example");
		expect(() => validateRpcUrl("http://rpc.example", 1)).toThrow(EnvError);
		expect(() => validateRpcUrl("http://rpc.example", 11155111)).toThrow(EnvError);
	});

	it("rejects ws and wss because the app constructs an HTTP transport", () => {
		expect(() => validateRpcUrl("wss://rpc.example", 1)).toThrow(/HTTP transport/);
		expect(() => validateRpcUrl("ws://127.0.0.1:8545", 31337)).toThrow(/HTTP transport/);
	});

	it("allows plain HTTP only for loopback anvil", () => {
		expect(validateRpcUrl("http://127.0.0.1:8545", 31337)).toBe(
			"http://127.0.0.1:8545",
		);
		expect(validateRpcUrl("http://localhost:8545", 31337)).toBe(
			"http://localhost:8545",
		);
		expect(() => validateRpcUrl("http://192.168.1.5:8545", 31337)).toThrow(
			/only allowed for local anvil/,
		);
	});

	it("rejects malformed and non-HTTP URLs", () => {
		expect(() => validateRpcUrl("not a url", 1)).toThrow(EnvError);
		expect(() => validateRpcUrl("ftp://rpc.example", 1)).toThrow(EnvError);
	});
});

describe("block explorer URL validation", () => {
	it("accepts only the canonical explorer for the chain", () => {
		expect(validateBlockExplorerUrl("https://etherscan.io", 1)).toBe(
			"https://etherscan.io",
		);
		expect(validateBlockExplorerUrl("https://etherscan.io/", 1)).toBe(
			"https://etherscan.io",
		);
		expect(
			validateBlockExplorerUrl("https://sepolia.etherscan.io", 11155111),
		).toBe("https://sepolia.etherscan.io");
		expect(() =>
			validateBlockExplorerUrl("https://sepolia.etherscan.io", 1),
		).toThrow(EnvError);
		expect(() =>
			validateBlockExplorerUrl("https://etherscan.io", 11155111),
		).toThrow(EnvError);
	});

	it("returns empty when unset so the per-chain default applies", () => {
		expect(validateBlockExplorerUrl(undefined, 1)).toBe("");
		expect(validateBlockExplorerUrl("", 11155111)).toBe("");
	});

	it("allows any http(s) URL on local anvil", () => {
		expect(validateBlockExplorerUrl("http://localhost:9999", 31337)).toBe(
			"http://localhost:9999",
		);
		expect(() => validateBlockExplorerUrl("ftp://x", 31337)).toThrow(EnvError);
	});
});

// assertProductionEnv reads process.env at module scope, so each case stubs the env and
// imports a fresh copy of the module.
describe("production build gate", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	async function loadFresh() {
		vi.resetModules();
		return await import("@/lib/env");
	}

	function stubValidMainnetProduction() {
		vi.stubEnv("PANORAMA_PRODUCTION", "1");
		vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "1");
		vi.stubEnv("NEXT_PUBLIC_RPC_URL", "https://rpc.example");
		vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "project-id");
		vi.stubEnv(
			"NEXT_PUBLIC_PANORAMA_AUCTION_ADDRESS",
			"0x1111111111111111111111111111111111111111",
		);
		vi.stubEnv("NEXT_PUBLIC_AUCTION_DEPLOY_BLOCK", "1");
	}

	it("passes a fully configured mainnet production env", async () => {
		stubValidMainnetProduction();
		const env = await loadFresh();
		expect(() => env.assertProductionEnv()).not.toThrow();
	});

	it("rejects the demo flag on a mainnet production build", async () => {
		stubValidMainnetProduction();
		vi.stubEnv("NEXT_PUBLIC_AUCTION_DEMO", "1");
		const env = await loadFresh();
		expect(() => env.assertProductionEnv()).toThrow(/AUCTION_DEMO/);
	});

	it("rejects the demo flag even on a non-mainnet production build", async () => {
		vi.stubEnv("PANORAMA_PRODUCTION", "1");
		vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "11155111");
		vi.stubEnv("NEXT_PUBLIC_AUCTION_DEMO", "1");
		const env = await loadFresh();
		expect(() => env.assertProductionEnv()).toThrow(/AUCTION_DEMO/);
	});

	it("allows the demo flag outside production platforms", async () => {
		vi.stubEnv("NEXT_PUBLIC_AUCTION_DEMO", "1");
		const env = await loadFresh();
		expect(() => env.assertProductionEnv()).not.toThrow();
	});

	it("blocks a production build pointed at a foreign CDN", async () => {
		stubValidMainnetProduction();
		vi.stubEnv("NEXT_PUBLIC_CDN_BASE_URL", "https://cdn.evil.example");
		const env = await loadFresh();
		expect(() => env.assertProductionEnv()).toThrow(/CDN_BASE_URL/);
	});

	it("blocks a production build pointed at a foreign repository", async () => {
		stubValidMainnetProduction();
		vi.stubEnv("NEXT_PUBLIC_GITHUB_URL", "https://gitlab.com/someone/panorama");
		const env = await loadFresh();
		expect(() => env.assertProductionEnv()).toThrow(/GITHUB_URL/);
	});
});

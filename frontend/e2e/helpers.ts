import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ANVIL_PORT = 8546;
export const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
export const E2E_DIR = __dirname;

/** anvil's well-known dev keys (local test chain only). */
export const ANVIL_KEYS = [
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
	"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
	"0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
	"0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
	"0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
	"0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
	"0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
	"0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
	"0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
	"0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
] as const;

export const OWNER = privateKeyToAccount(ANVIL_KEYS[0]).address;
export const BIDDER = privateKeyToAccount(ANVIL_KEYS[1]).address;
export const STRANGER = privateKeyToAccount(ANVIL_KEYS[2]).address;

export interface E2EState {
	auction: `0x${string}`;
	nft: `0x${string}`;
	controller: `0x${string}`;
	start: number;
	deployBlock: number;
}

export function readState(): E2EState {
	return JSON.parse(fs.readFileSync(path.join(E2E_DIR, ".state.json"), "utf8"));
}

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
	const res = await fetch(RPC_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const j = (await res.json()) as { result?: T; error?: { message: string } };
	if (j.error) throw new Error(`${method}: ${j.error.message}`);
	return j.result as T;
}

export const mine = (blocks = 1) => rpc("anvil_mine", [blocks]);

export async function chainNow(): Promise<number> {
	const block = await rpc<{ timestamp: string }>("eth_getBlockByNumber", ["latest", false]);
	return parseInt(block.timestamp, 16);
}

/** Move chain time to `target` (absolute unix seconds) and mine so the UI sees it. */
export async function warpTo(target: number) {
	await rpc("evm_setNextBlockTimestamp", [target]);
	await mine();
}

const auctionCallAbi = parseAbi([
	"function placeBid() payable",
	"function finalize(uint256 maxCount)",
	"function endTime() view returns (uint64)",
	"function phase() view returns (uint8)",
	"function activeBids() view returns (uint256)",
	"function clearingPrice() view returns (uint96)",
]);
const nftCallAbi = parseAbi(["function ownerOf(uint256 id) view returns (address)"]);
const nftAdminAbi = parseAbi([
	"function setAuthorizedOperator(address operator, bool authorized)",
]);

const hex = (v: bigint) => "0x" + v.toString(16);

/** Place a bid from any address by impersonation (no keys needed for bot wallets). */
export async function placeBidRaw(auction: `0x${string}`, from: `0x${string}`, valueWei: bigint, opts?: { gasPriceGwei?: number }) {
	await rpc("anvil_impersonateAccount", [from]);
	await rpc("anvil_setBalance", [from, hex(valueWei + 10n ** 18n)]);
	await rpc("eth_sendTransaction", [
		{
			from,
			to: auction,
			value: hex(valueWei),
			data: encodeFunctionData({ abi: auctionCallAbi, functionName: "placeBid" }),
			gas: "0x7a120",
			...(opts?.gasPriceGwei ? { gasPrice: hex(BigInt(opts.gasPriceGwei) * 10n ** 9n) } : {}),
		},
	]);
}

/** Deterministic throwaway bot addresses. */
export const bot = (i: number): `0x${string}` =>
	("0x" + (0xb0700000 + i).toString(16).padStart(40, "0")) as `0x${string}`;

/** Fill the auction with `count` bot bids of `valueWei`. */
export async function fillBids(auction: `0x${string}`, count: number, valueWei: bigint) {
	for (let i = 0; i < count; i++) {
		await placeBidRaw(auction, bot(i), valueWei);
	}
}

export async function readAuction<T>(auction: `0x${string}`, functionName: "endTime" | "phase" | "activeBids" | "clearingPrice"): Promise<T> {
	const data = encodeFunctionData({ abi: auctionCallAbi, functionName });
	const out = await rpc<string>("eth_call", [{ to: auction, data }, "latest"]);
	return BigInt(out) as T;
}

export async function ownerOf(nft: `0x${string}`, tokenId: number): Promise<string> {
	const data = encodeFunctionData({ abi: nftCallAbi, functionName: "ownerOf", args: [BigInt(tokenId)] });
	const out = await rpc<string>("eth_call", [{ to: nft, data }, "latest"]);
	return ("0x" + out.slice(-40)).toLowerCase();
}

/** Toggle auction mint authorization from the local NFT owner. */
export async function setAuctionOperator(
	nft: `0x${string}`,
	auction: `0x${string}`,
	authorized: boolean,
) {
	await rpc("eth_sendTransaction", [
		{
			from: OWNER,
			to: nft,
			data: encodeFunctionData({
				abi: nftAdminAbi,
				functionName: "setAuthorizedOperator",
				args: [auction, authorized],
			}),
			gas: "0x30d40",
		},
	]);
}

/** Finalize a local auction batch from its owner without involving the frontend. */
export async function finalizeRaw(auction: `0x${string}`, maxCount: bigint) {
	await rpc("eth_sendTransaction", [
		{
			from: OWNER,
			to: auction,
			data: encodeFunctionData({
				abi: auctionCallAbi,
				functionName: "finalize",
				args: [maxCount],
			}),
			gas: "0xe4e1c0",
		},
	]);
}

/**
 * Injects a minimal EIP-1193 + EIP-6963 wallet backed by anvil's unlocked accounts.
 * eth_sendTransaction is forwarded straight to anvil (which signs for its dev accounts),
 * so no client-side key handling is needed. `window.__rejectNextTx = true` makes the next
 * transaction request throw a 4001 user rejection, for rejection-path tests.
 */
export async function installWallet(page: Page, account: `0x${string}`) {
	await page.addInitScript(
		({ account, rpcUrl }) => {
			let id = 1;
			async function forward(method: string, params: unknown[]) {
				const res = await fetch(rpcUrl, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
				});
				const j = await res.json();
				if (j.error) {
					const e = new Error(j.error.message) as Error & { code?: number; data?: unknown };
					e.code = j.error.code;
					e.data = j.error.data;
					throw e;
				}
				return j.result;
			}
			const provider = {
				isE2EWallet: true,
				request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
					if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
					if (method === "eth_chainId") return "0x7a69"; // 31337
					if (method === "wallet_switchEthereumChain") return null;
					if (method === "eth_sendTransaction") {
						const w = window as unknown as { __rejectNextTx?: boolean };
						if (w.__rejectNextTx) {
							w.__rejectNextTx = false;
							const e = new Error("User rejected the request.") as Error & { code: number };
							e.code = 4001;
							throw e;
						}
					}
					return forward(method, params);
				},
				on: () => {},
				removeListener: () => {},
			};
			(window as unknown as { ethereum: unknown }).ethereum = provider;
			const info = {
				uuid: "e2e-wallet-0000-0000",
				name: "E2E Wallet",
				icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
				rdns: "dev.e2e.wallet",
			};
			const announce = () =>
				window.dispatchEvent(
					new CustomEvent("eip6963:announceProvider", {
						detail: Object.freeze({ info, provider }),
					}),
				);
			window.addEventListener("eip6963:requestProvider", announce);
			announce();
		},
		{ account, rpcUrl: RPC_URL },
	);
}

/**
 * Ensure the E2E wallet is connected. wagmi's reconnect-on-mount usually connects the
 * announced EIP-6963 provider automatically (its eth_accounts is non-empty); when it
 * does not, click through WalletPill -> modal -> the injected E2E wallet.
 */
export async function connectWallet(page: Page) {
	const pill = page.getByRole("button", { name: /^connect( wallet)?$/i }).first();
	const needsClick = await pill
		.waitFor({ state: "visible", timeout: 4000 })
		.then(() => true)
		.catch(() => false);
	if (needsClick) {
		await pill.click();
		await page.getByRole("button", { name: /e2e wallet/i }).click();
	}
}

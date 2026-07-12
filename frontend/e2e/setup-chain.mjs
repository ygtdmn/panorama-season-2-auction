// Boots anvil on port 8546 and deploys the full contract stack from the sibling Foundry
// project's forge artifacts. Called by start-next.mjs BEFORE the Next dev server starts,
// because Playwright launches the webServer before globalSetup runs.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";

const DIR = path.dirname(fileURLToPath(import.meta.url));
// The Foundry project sits at smart-contracts/ in the monorepo and at contracts/ in the
// standalone release repo; resolve whichever layout this copy lives in.
const OUT_DIR = ["../../smart-contracts/out", "../../contracts/out"]
	.map((rel) => path.resolve(DIR, rel))
	.find((p) => fs.existsSync(p));
if (!OUT_DIR) {
	throw new Error(
		"no forge artifacts found; run `forge build` in the sibling Foundry project (smart-contracts/ or contracts/)",
	);
}
const ANVIL_PORT = 8546;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PAYOUT_A = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f"; // anvil #8
const PAYOUT_B = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"; // anvil #9

async function rpc(method, params = []) {
	const res = await fetch(RPC_URL, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const j = await res.json();
	if (j.error) throw new Error(`${method}: ${j.error.message}`);
	return j.result;
}

function artifact(solFile, name) {
	const p = path.join(OUT_DIR, solFile, `${name}.json`);
	const j = JSON.parse(fs.readFileSync(p, "utf8"));
	if (!j.bytecode?.object || j.bytecode.object === "0x") {
		throw new Error(`artifact ${p} has no bytecode; run \`forge build\` in the sibling Foundry project`);
	}
	return { abi: j.abi, bytecode: j.bytecode.object };
}

async function rpcUp() {
	try {
		await rpc("eth_chainId");
		return true;
	} catch {
		return false;
	}
}

export async function setupChain() {
	// Kill a stale anvil from a previous run, if any.
	const pidFile = path.join(DIR, ".anvil.pid");
	if (await rpcUp()) {
		try {
			process.kill(Number(fs.readFileSync(pidFile, "utf8")));
		} catch {
			/* not ours; the spawn below will fail loudly on the busy port */
		}
		await new Promise((r) => setTimeout(r, 500));
	}

	const anvilProc = spawn("anvil", ["--port", String(ANVIL_PORT), "--chain-id", "31337", "--silent"], {
		detached: true,
		stdio: "ignore",
	});
	anvilProc.unref();
	fs.writeFileSync(pidFile, String(anvilProc.pid));

	const deadline = Date.now() + 30_000;
	while (!(await rpcUp())) {
		if (Date.now() > deadline) throw new Error("anvil did not come up on " + RPC_URL);
		await new Promise((r) => setTimeout(r, 250));
	}

	const owner = privateKeyToAccount(KEY0);
	const chain = { ...anvil, id: 31337 };
	const pub = createPublicClient({ chain, transport: http(RPC_URL) });
	const wallet = createWalletClient({ account: owner, chain, transport: http(RPC_URL) });

	const panoramaArt = artifact("Panorama.sol", "Panorama");
	const controllerArt = artifact("PanoramaMintController.sol", "PanoramaMintController");
	const auctionArt = artifact("PanoramaSeason2Auction.sol", "PanoramaSeason2Auction");

	async function deploy(art, args = []) {
		const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
		const receipt = await pub.waitForTransactionReceipt({ hash });
		return receipt.contractAddress;
	}
	async function write(address, abi, functionName, args) {
		const hash = await wallet.writeContract({ address, abi, functionName, args });
		await pub.waitForTransactionReceipt({ hash });
	}

	// Season 1 baseline: 90 minted, cap 90; Season 2 cap pre-set for settlement tests.
	const nft = await deploy(panoramaArt);
	const controller = await deploy(controllerArt);
	await write(nft, panoramaArt.abi, "setMintController", [controller]);
	await write(controller, controllerArt.abi, "setSeasonMintCap", [1, 90n]);
	await write(nft, panoramaArt.abi, "mintTo", [owner.address, 90n]);
	await write(controller, controllerArt.abi, "setSeasonMintCap", [2, 90n]);

	const block = await pub.getBlock();
	const start = Number(block.timestamp) + 300;
	const auction = await deploy(auctionArt, [
		nft,
		parseEther("0.1"),
		500,
		BigInt(start),
		7200n,
		PAYOUT_A,
		PAYOUT_B,
	]);
	const deployBlock = await pub.getBlockNumber();
	await write(nft, panoramaArt.abi, "setAuthorizedOperator", [auction, true]);

	// Open bidding: move chain time just past the start and mine so the UI sees it.
	await rpc("evm_setNextBlockTimestamp", [start + 5]);
	await rpc("anvil_mine", [1]);

	fs.writeFileSync(
		path.join(DIR, ".env.e2e.local"),
		[
			"NEXT_PUBLIC_CHAIN_ID=31337",
			`NEXT_PUBLIC_RPC_URL=${RPC_URL}`,
			`NEXT_PUBLIC_PANORAMA_AUCTION_ADDRESS=${auction}`,
			`NEXT_PUBLIC_PANORAMA_NFT_ADDRESS=${nft}`,
			`NEXT_PUBLIC_AUCTION_DEPLOY_BLOCK=${deployBlock}`,
			"NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=",
			"NEXT_PUBLIC_AUCTION_DEMO=",
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(DIR, ".state.json"),
		JSON.stringify({ auction, nft, controller, start, deployBlock: Number(deployBlock) }, null, 2),
	);

	console.log(`[e2e] anvil pid=${anvilProc.pid} auction=${auction}`);
	return { rpcUrl: RPC_URL, auction, nft };
}

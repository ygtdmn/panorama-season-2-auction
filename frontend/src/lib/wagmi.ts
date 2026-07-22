import { anvil, mainnet, sepolia } from "wagmi/chains";
import { createConfig, fallback, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import type { Chain } from "viem";
import { ENV } from "./env";
import { AUCTION_SITE_URL, CDN_BASE_URL } from "./constants";

// Which chain the app targets at runtime. Defaults to mainnet; set
// NEXT_PUBLIC_CHAIN_ID=11155111 for Sepolia or 31337 for a local anvil node
// (contracts, ENS lookups, wrong-network detection). Values are validated in env.ts.
export const TARGET_CHAIN: Chain =
	ENV.chainId === sepolia.id ? sepolia : ENV.chainId === anvil.id ? anvil : mainnet;

// The authenticated primary RPC. Required for mainnet production builds (env.ts enforces it);
// the public lists below are a degraded fallback, not a launch configuration.
const CLIENT_RPC_OVERRIDE = ENV.rpcUrl;

const mainnetTransport = fallback([
	...(TARGET_CHAIN.id === mainnet.id && CLIENT_RPC_OVERRIDE ? [http(CLIENT_RPC_OVERRIDE)] : []),
	http("https://eth-mainnet.g.alchemy.com/v2/alch_nZeV4lIRQidp0HDWfIsyx"),
	http("https://ethereum-rpc.publicnode.com"),
	http("https://1rpc.io/eth"),
	http("https://rpc.mevblocker.io"),
	http("https://rpc.flashbots.net"),
	http("https://eth.meowrpc.com"),
	http("https://eth.drpc.org"),
	http("https://eth.merkle.io"),
	http("https://endpoints.omniatech.io/v1/eth/mainnet/public"),
	http("https://0xrpc.io/eth"),
	http("https://rpc.payload.de"),
	http("https://rpc.public.curie.radiumblock.co/http/ethereum"),
	http("https://eth.blockrazor.xyz"),
]);

const sepoliaTransport = fallback([
	...(TARGET_CHAIN.id === sepolia.id && CLIENT_RPC_OVERRIDE ? [http(CLIENT_RPC_OVERRIDE)] : []),
	http("https://ethereum-sepolia-rpc.publicnode.com"),
	http("https://sepolia.drpc.org"),
	http("https://rpc.sepolia.org"),
	http("https://rpc2.sepolia.org"),
	http("https://1rpc.io/sepolia"),
	http(),
]);

const anvilTransport = http(CLIENT_RPC_OVERRIDE || "http://127.0.0.1:8545");

// WalletConnect is only registered when a project id exists. env.ts fails a mainnet
// production BUILD without one; this guard keeps dev/test builds from constructing a
// connector that would crash at runtime.
const WC_PROJECT_ID = ENV.walletConnectProjectId;

export const config = createConfig({
	chains: [TARGET_CHAIN],
	connectors: [
		injected(),
		...(WC_PROJECT_ID
			? [
					walletConnect({
						projectId: WC_PROJECT_ID,
						// The metadata url must be this app's real origin: wallets display it during
						// connection prompts, and a mismatched origin reads as a phishing signal.
						metadata: {
							name: "Panorama Season 2 Auction",
							description:
								"Bid on Season 2 of Panorama, an autonomous generative painting.",
							url: AUCTION_SITE_URL,
							icons: [`${CDN_BASE_URL}/prereveal.webp`],
						},
						showQrModal: true,
					}),
				]
			: []),
	],
	transports: {
		[mainnet.id]: mainnetTransport,
		[sepolia.id]: sepoliaTransport,
		[anvil.id]: anvilTransport,
	},
	ssr: true,
});

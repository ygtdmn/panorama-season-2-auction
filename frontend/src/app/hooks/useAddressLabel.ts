"use client";

import { useEnsName } from "wagmi";
import { mainnet } from "wagmi/chains";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isHexAddress(value: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function shortAddress(address: string): string {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// ENS only exists on mainnet, so resolve names there even when the rest of
// the app is targeting Sepolia for contract reads.
export function useAddressLabel(address: string | undefined | null): string {
	const valid =
		!!address &&
		isHexAddress(address) &&
		address.toLowerCase() !== ZERO_ADDRESS;

	const { data: ensName } = useEnsName({
		address: valid ? (address as `0x${string}`) : undefined,
		chainId: mainnet.id,
		query: {
			enabled: valid,
			staleTime: 24 * 60 * 60 * 1000,
			gcTime: 24 * 60 * 60 * 1000,
		},
	});

	if (!valid) return "";
	return ensName ?? shortAddress(address!);
}

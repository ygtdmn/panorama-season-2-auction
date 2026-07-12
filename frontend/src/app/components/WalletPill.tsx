"use client";

import { useAccount, useDisconnect, useEnsName, useSwitchChain } from "wagmi";
import { LuChevronDown } from "react-icons/lu";
import { useEffect, useRef, useState } from "react";
import { useWalletModal } from "@/app/components/WalletModal";
import { TARGET_CHAIN } from "@/lib/wagmi";
import { mainnet } from "wagmi/chains";

const BASE =
	"font-mono text-[11px] uppercase tracking-[0.2em] tabular-nums text-foreground border border-line hover:border-foreground transition-colors inline-flex items-center cursor-pointer";

const PAD = {
	paddingLeft: 14,
	paddingRight: 10,
	paddingTop: 8,
	paddingBottom: 8,
	lineHeight: 1,
	gap: 8,
} as const;

function shortAddress(addr?: string | null): string {
	if (!addr) return "";
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface WalletPillProps {
	/** Shown when wallet disconnected. Defaults to "connect wallet". */
	connectLabel?: string;
}

export function WalletPill({ connectLabel = "connect wallet" }: WalletPillProps) {
	// `useAccount().chainId` is the wallet's actual connected chain. Do NOT use
	// `useChainId()` — that returns wagmi's config chain (always the target), so
	// it never flags a wallet sitting on Base/Arbitrum/etc.
	const { address, isConnected, chainId } = useAccount();
	const { switchChain, isPending: switching } = useSwitchChain();
	const { disconnect } = useDisconnect();
	// ENS only exists on mainnet, so resolve names there even when the app
	// itself is targeting Sepolia for contract reads.
	const { data: ensName } = useEnsName({ address, chainId: mainnet.id });
	const { open } = useWalletModal();

	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	// Avoid server/client mismatch: wagmi hydrates after mount, so render a
	// placeholder until the client takes over.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	useEffect(() => {
		if (!menuOpen) return;
		const onDown = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setMenuOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [menuOpen]);

	if (!mounted) {
		return (
			<div aria-hidden="true" style={{ opacity: 0, pointerEvents: "none" }}>
				<button type="button" className={BASE} style={PAD}>
					<span className="whitespace-nowrap">{connectLabel}</span>
					<LuChevronDown size={12} strokeWidth={1.75} />
				</button>
			</div>
		);
	}

	if (!isConnected || !address) {
		return (
			<button type="button" onClick={open} className={BASE} style={PAD}>
				<span className="whitespace-nowrap">{connectLabel}</span>
				<LuChevronDown size={12} strokeWidth={1.75} />
			</button>
		);
	}

	const wrongNetwork = chainId !== TARGET_CHAIN.id;
	const label = wrongNetwork ? "wrong network" : (ensName ?? shortAddress(address));

	return (
		<div ref={menuRef} className="relative inline-block">
			<button
				type="button"
				onClick={() => setMenuOpen((v) => !v)}
				className={`${BASE} ${wrongNetwork ? "text-signal border-signal/60" : ""}`}
				style={PAD}
			>
				<span className="whitespace-nowrap max-w-[180px] overflow-hidden text-ellipsis">
					{label}
				</span>
				<LuChevronDown size={12} strokeWidth={1.75} />
			</button>

			{menuOpen && (
				<div className="absolute right-0 top-full mt-1 min-w-[180px] bg-background border border-line z-50">
					{wrongNetwork && (
						<button
							type="button"
							disabled={switching}
							onClick={() => {
								switchChain({ chainId: TARGET_CHAIN.id });
								setMenuOpen(false);
							}}
							className="w-full text-left font-mono text-[11px] uppercase tracking-[0.2em] text-signal px-3 py-2 hover:bg-foreground/[0.04] transition-colors cursor-pointer disabled:opacity-50 border-b border-line"
						>
							{switching ? "switching…" : `switch to ${TARGET_CHAIN.name}`}
						</button>
					)}
					<button
						type="button"
						onClick={() => {
							setMenuOpen(false);
							disconnect();
						}}
						className="w-full text-left font-mono text-[11px] uppercase tracking-[0.2em] text-foreground px-3 py-2 hover:bg-foreground/[0.04] transition-colors cursor-pointer"
					>
						disconnect
					</button>
				</div>
			)}
		</div>
	);
}

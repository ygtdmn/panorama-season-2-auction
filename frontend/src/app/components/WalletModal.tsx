"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useAccount, useConnect, useConnectors, useDisconnect } from "wagmi";
import type { Connector } from "wagmi";
import { LuX } from "react-icons/lu";

// ─────────────────────────────────────────────────────────────
// Modal context — anything that needs to prompt the user for a
// wallet connection calls `openWalletModal()`. One modal lives
// at the app root so we don't juggle multiple stacks.
// ─────────────────────────────────────────────────────────────

type WalletModalContextValue = {
	open: () => void;
	close: () => void;
};

const WalletModalContext = createContext<WalletModalContextValue | null>(null);

export function useWalletModal(): WalletModalContextValue {
	const ctx = useContext(WalletModalContext);
	if (!ctx) throw new Error("useWalletModal must be used inside WalletModalProvider");
	return ctx;
}

// Partition connectors into "installed in this browser" vs WalletConnect.
// We drop the generic `injected` fallback when EIP-6963 announced at
// least one concrete wallet, since it just restates `window.ethereum`.
function partitionConnectors(connectors: readonly Connector[]): {
	installed: Connector[];
	walletConnect: Connector | null;
} {
	const eip6963: Connector[] = [];
	let genericInjected: Connector | null = null;
	let walletConnect: Connector | null = null;

	for (const c of connectors) {
		if (c.id === "walletConnect") {
			walletConnect = c;
			continue;
		}
		if (c.type === "injected") {
			// wagmi's EIP-6963 connectors have the rdns of the wallet as `id`
			// (e.g. "io.metamask", "io.rabby"). The bare fallback has id "injected".
			if (c.id === "injected") {
				genericInjected = c;
			} else {
				eip6963.push(c);
			}
		}
	}

	const installed = eip6963.length > 0 ? eip6963 : genericInjected ? [genericInjected] : [];
	return { installed, walletConnect };
}

// ─────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────

export function WalletModalProvider({ children }: { children: React.ReactNode }) {
	const [isOpen, setIsOpen] = useState(false);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const open = useCallback(() => {
		returnFocusRef.current =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setIsOpen(true);
	}, []);
	const close = useCallback(() => setIsOpen(false), []);
	const value = useMemo(() => ({ open, close }), [open, close]);

	return (
			<WalletModalContext.Provider value={value}>
				{children}
				<WalletModal isOpen={isOpen} onClose={close} returnFocusRef={returnFocusRef} />
		</WalletModalContext.Provider>
	);
}

// ─────────────────────────────────────────────────────────────
// Modal
// ─────────────────────────────────────────────────────────────

const TYPE = "font-mono uppercase tabular-nums";
const ROW =
	"group w-full flex items-center gap-3 px-4 py-3 border-t border-line hover:bg-foreground/[0.04] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed";

const FOCUSABLE =
	'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function WalletModal({
	isOpen,
	onClose,
	returnFocusRef,
}: {
	isOpen: boolean;
	onClose: () => void;
	returnFocusRef: React.RefObject<HTMLElement | null>;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const { address, isConnected } = useAccount();
	const { connectAsync, isPending, variables } = useConnect();
	const { disconnect } = useDisconnect();
	const connectors = useConnectors();
	const [error, setError] = useState<string | null>(null);
	// Track disconnects inside the open modal. Disconnect should keep the modal
	// open for switching wallets; the next successful connect should close it.
	const wasOpenRef = useRef(false);
	const openedDisconnectedRef = useRef(false);
	const disconnectedInModalRef = useRef(false);

	const { installed, walletConnect } = useMemo(
		() => partitionConnectors(connectors),
		[connectors],
	);

	useEffect(() => {
		if (isOpen && !wasOpenRef.current) {
			openedDisconnectedRef.current = !isConnected;
			disconnectedInModalRef.current = false;
		}
		wasOpenRef.current = isOpen;
	}, [isOpen, isConnected]);

	// Any successful connect while the modal is open should close it. The only
	// connected state that stays open is the initial manage-wallet view.
	useEffect(() => {
		if (
			isOpen &&
			isConnected &&
			(openedDisconnectedRef.current || disconnectedInModalRef.current)
		) {
			onClose();
		}
	}, [isOpen, isConnected, onClose]);

	// Clear stale error whenever the modal reopens.
	useEffect(() => {
		if (isOpen) setError(null);
	}, [isOpen]);

	// Initial focus, keyboard trap, Escape, and trigger-focus restoration.
	useEffect(() => {
		if (!isOpen) return;
		const returnFocus = returnFocusRef.current;
		let tabBackwards = false;
		const focusTimer = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
				return;
			}
			if (e.key !== "Tab" || !panelRef.current) return;
			tabBackwards = e.shiftKey;
			const focusable = Array.from(
				panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
			).filter((element) => !element.hasAttribute("disabled"));
			if (focusable.length === 0) {
				e.preventDefault();
				panelRef.current.focus();
				return;
			}
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (!panelRef.current.contains(document.activeElement)) {
				e.preventDefault();
				(e.shiftKey ? last : first).focus();
			} else if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		};
		// Key capture handles normal Tab traversal. focusin is a defensive fallback for browser
		// extensions or embedded wallet UI that moves focus without a keyboard event.
		const onFocusIn = (e: FocusEvent) => {
			const panel = panelRef.current;
			if (!panel || panel.contains(e.target as Node)) return;
			const focusable = Array.from(
				panel.querySelectorAll<HTMLElement>(FOCUSABLE),
			).filter((element) => !element.hasAttribute("disabled"));
			(tabBackwards ? focusable.at(-1) : focusable[0])?.focus();
		};
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("focusin", onFocusIn, true);
		return () => {
			window.cancelAnimationFrame(focusTimer);
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("focusin", onFocusIn, true);
			window.requestAnimationFrame(() => {
				if (returnFocus?.isConnected) returnFocus.focus();
			});
		};
	}, [isOpen, onClose, returnFocusRef]);

	// Lock body scroll while the dialog is up.
	useEffect(() => {
		if (!isOpen) return;
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, [isOpen]);

	const handleConnect = useCallback(
		async (connector: Connector) => {
			setError(null);
			try {
				await connectAsync({ connector });
				onClose();
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : "Connection failed.";
				// Users cancelling the wallet prompt shouldn't look like an error —
				// wagmi surfaces that as "User rejected" / code 4001.
				if (/reject|denied|cancel/i.test(message)) return;
				setError(message);
			}
		},
		[connectAsync, onClose],
	);

	const handleBackdrop = useCallback(
		(e: React.MouseEvent) => {
			if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
				onClose();
			}
		},
		[onClose],
	);
	if (!isOpen) return null;

	const pendingId = isPending ? variables?.connector && "id" in variables.connector ? variables.connector.id : null : null;

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="wallet-modal-heading"
			className="fixed inset-0 z-[200] flex items-center justify-center px-4"
			onClick={handleBackdrop}
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/60" aria-hidden="true" />

			{/* Panel */}
				<div
					ref={panelRef}
					tabIndex={-1}
					className="relative w-full max-w-[380px] bg-background border border-line animate-modal-in"
			>
				{/* Header */}
				<div className="flex items-center justify-between px-4 py-3">
					<h2
						id="wallet-modal-heading"
						className={`${TYPE} text-[11px] tracking-[0.2em] text-foreground`}
					>
						connect wallet
					</h2>
					<button
						ref={closeButtonRef}
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="text-muted hover:text-foreground transition-colors cursor-pointer"
					>
						<LuX size={16} strokeWidth={1.5} />
					</button>
				</div>

				{/* Connected — show current address, disconnect, and offer switch */}
				{isConnected && address && (
					<>
						<div className="px-4 pt-1 pb-2 flex items-center justify-between border-t border-line">
							<span className={`${TYPE} text-[10px] tracking-[0.2em] text-muted`}>
								connected
							</span>
							<span
								className={`${TYPE} text-[11px] tracking-[0.15em] text-foreground`}
								title={address}
							>
								{address.slice(0, 6)}…{address.slice(-4)}
							</span>
						</div>
						<button
							type="button"
							onClick={() => {
								disconnectedInModalRef.current = true;
								disconnect();
							}}
							className={`${ROW} justify-between`}
						>
							<span className={`${TYPE} text-[12px] tracking-[0.15em] text-foreground`}>
								disconnect
							</span>
							<span className={`${TYPE} text-[10px] tracking-[0.15em] text-muted`}>
								[ ✕ ]
							</span>
						</button>
						{installed.length > 0 && (
							<div className="px-4 pt-4 pb-2">
								<span className={`${TYPE} text-[10px] tracking-[0.2em] text-muted`}>
									switch wallet
								</span>
							</div>
						)}
					</>
				)}

				{/* Installed wallets — shown when disconnected, OR after disconnect for switching */}
				{installed.length > 0 && (
					<div>
						{!isConnected && (
							<div className="px-4 pt-1 pb-2">
								<span className={`${TYPE} text-[10px] tracking-[0.2em] text-muted`}>
									detected
								</span>
							</div>
						)}
						{installed.map((c) => (
								<ConnectorRow
								key={c.uid}
								connector={c}
									pending={pendingId === c.id}
									disabled={isPending}
								onClick={() => handleConnect(c)}
							/>
						))}
					</div>
				)}

				{/* WalletConnect fallback */}
				{walletConnect && (
					<div>
						{installed.length > 0 && (
							<div className="px-4 pt-4 pb-2">
								<span className={`${TYPE} text-[10px] tracking-[0.2em] text-muted`}>
									or scan
								</span>
							</div>
						)}
							<ConnectorRow
								connector={walletConnect}
								pending={pendingId === walletConnect.id}
								disabled={isPending}
							onClick={() => handleConnect(walletConnect)}
						/>
					</div>
				)}

				{/* Empty state — no installed wallet, no WalletConnect (unlikely) */}
				{!isConnected && installed.length === 0 && !walletConnect && (
					<div className="px-4 py-6">
						<p className={`${TYPE} text-[11px] tracking-[0.15em] text-muted leading-[1.7]`}>
							no wallet detected. install a browser wallet or use walletconnect.
						</p>
					</div>
				)}

				{error && (
					<div className="px-4 py-3 border-t border-line">
						<p className={`${TYPE} text-[10px] tracking-[0.15em] text-signal leading-[1.5]`}>
							{error}
						</p>
					</div>
				)}
			</div>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────
// Row
// ─────────────────────────────────────────────────────────────

function ConnectorRow({
	connector,
	pending,
	disabled,
	onClick,
}: {
	connector: Connector;
	pending: boolean;
	disabled: boolean;
	onClick: () => void;
}) {
	const icon = (connector as { icon?: string }).icon;
	const label =
		connector.id === "walletConnect" ? "walletconnect" : connector.name.toLowerCase();

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={ROW}
		>
			<span
				className="w-7 h-7 flex items-center justify-center bg-surface border border-line shrink-0 overflow-hidden"
				aria-hidden="true"
			>
				{icon ? (
					// eslint-disable-next-line @next/next/no-img-element
					<img src={icon} alt="" className="w-full h-full object-contain" />
				) : (
					<WalletGlyph id={connector.id} />
				)}
			</span>
			<span className={`${TYPE} text-[12px] tracking-[0.15em] text-foreground flex-1 text-left`}>
				{label}
			</span>
			<span className={`${TYPE} text-[10px] tracking-[0.2em] text-muted`}>
				{pending ? "connecting…" : "connect"}
			</span>
		</button>
	);
}

// Minimal fallback glyph when a connector has no icon (rare — EIP-6963
// wallets and WalletConnect both provide one). A tiny square avoids any
// dependency on emoji or third-party icon fonts.
function WalletGlyph({ id }: { id: string }) {
	const letter = id === "walletConnect" ? "W" : id.charAt(0).toUpperCase();
	return (
		<span className={`${TYPE} text-[11px] tracking-normal text-muted`}>{letter}</span>
	);
}

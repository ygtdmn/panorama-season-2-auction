"use client";

import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react";

type ToastVariant = "error" | "success" | "info";
type Toast = { id: number; message: string; variant: ToastVariant };

export interface ToastApi {
	error: (message: string) => void;
	success: (message: string) => void;
	info: (message: string) => void;
}

const noop: ToastApi = { error: () => {}, success: () => {}, info: () => {} };

const ToastContext = createContext<ToastApi>(noop);

export const useToast = () => useContext(ToastContext);

const VARIANT_LABEL: Record<ToastVariant, string> = {
	error: "Error",
	success: "Confirmed",
	info: "Notice",
};

const VARIANT_COLOR: Record<ToastVariant, string> = {
	error: "var(--signal)",
	success: "var(--up)",
	info: "var(--muted)",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const nextIdRef = useRef(0);

	const push = useCallback((message: string, variant: ToastVariant) => {
		const id = ++nextIdRef.current;
		setToasts((prev) => [...prev, { id, message, variant }]);
	}, []);

	const api = useMemo<ToastApi>(
		() => ({
			error: (m: string) => push(m, "error"),
			success: (m: string) => push(m, "success"),
			info: (m: string) => push(m, "info"),
		}),
		[push],
	);

	const dismiss = useCallback((id: number) => {
		setToasts((prev) => prev.filter((t) => t.id !== id));
	}, []);

	return (
		<ToastContext.Provider value={api}>
			{children}
			{/* aria-live so wallet errors and confirmations are announced to screen readers */}
			<div
				className="fixed bottom-6 left-6 z-[1000] flex flex-col gap-2 max-w-sm"
				role="status"
				aria-live="polite"
			>
				{toasts.map((toast) => (
					<ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
				))}
			</div>
		</ToastContext.Provider>
	);
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
	const [visible, setVisible] = useState(false);
	// Errors stay longer than confirmations; both are click-dismissable.
	const ttl = toast.variant === "error" ? 8000 : 4000;

	useEffect(() => {
		requestAnimationFrame(() => setVisible(true));
		const timer = setTimeout(() => {
			setVisible(false);
			setTimeout(() => onDismiss(toast.id), 200);
		}, ttl);
		return () => clearTimeout(timer);
	}, [toast.id, onDismiss, ttl]);

	return (
		<div
			role={toast.variant === "error" ? "alert" : undefined}
			className={`bg-background border border-line cursor-pointer transition-all duration-200 ease-out ${
				visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
			}`}
			onClick={() => {
				setVisible(false);
				setTimeout(() => onDismiss(toast.id), 200);
			}}
		>
			<div className="flex items-start gap-3 px-4 py-3">
				<span
					className="w-2 h-2 mt-[6px] shrink-0"
					style={{ background: VARIANT_COLOR[toast.variant] }}
					aria-hidden
				/>
				<div className="flex flex-col gap-1">
					<span
						className="font-mono text-[10px] uppercase"
						style={{ letterSpacing: "0.2em", color: VARIANT_COLOR[toast.variant] }}
					>
						{VARIANT_LABEL[toast.variant]}
					</span>
					<span className="font-mono text-xs text-foreground">{toast.message}</span>
				</div>
			</div>
		</div>
	);
}

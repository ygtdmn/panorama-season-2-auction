"use client";

import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "@/lib/wagmi";
import { useState } from "react";
import { ToastProvider } from "./components/Toast";
import { ThemeProvider } from "./components/ThemeProvider";
import { TooltipProvider } from "./components/TooltipProvider";
import { WalletModalProvider } from "./components/WalletModal";

export function Providers({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(() => new QueryClient());

	return (
		<ThemeProvider>
			<WagmiProvider config={config}>
				<QueryClientProvider client={queryClient}>
					<ToastProvider>
						<WalletModalProvider>{children}</WalletModalProvider>
						<TooltipProvider />
					</ToastProvider>
				</QueryClientProvider>
			</WagmiProvider>
		</ThemeProvider>
	);
}

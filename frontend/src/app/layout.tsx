import type { Metadata } from "next";
// Self-hosted fonts: vinext would load next/font/google from Google's CDN at runtime.
// Mono for the small technical labels; Hanken Grotesk as the clean sans/serif base.
import "@fontsource-variable/hanken-grotesk/wght.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./globals.css";
import { Providers } from "./providers";
import { themeInitScript } from "@/lib/themeScript";
import { railMaxInitScript } from "@/lib/railMax";
import { AUCTION_SITE_URL, OG_IMAGE_URL } from "@/lib/constants";

const description =
	"Bid on Season 2 of Panorama, an autonomous generative artwork. A collaboration between Yigit Duman and DeltaSauce.";

export const metadata: Metadata = {
	metadataBase: new URL(AUCTION_SITE_URL),
	title: "Panorama: Season 2",
	description,
	icons: {
		icon: [{ url: "/favicon.png" }],
		shortcut: "/favicon.png",
		apple: "/favicon.png",
	},
	authors: [{ name: "Yigit Duman" }, { name: "DeltaSauce" }],
	robots: "index, follow",
	openGraph: {
		title: "Panorama: Season 2",
		description,
		type: "website",
		url: AUCTION_SITE_URL,
		siteName: "Panorama",
		locale: "en_US",
		images: [{ url: OG_IMAGE_URL, width: 1920, height: 1080, alt: "Panorama", type: "image/jpeg" }],
	},
	twitter: {
		card: "summary_large_image",
		title: "Panorama: Season 2",
		description,
		creator: "@yigitduman",
		images: [OG_IMAGE_URL],
	},
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" className="h-full" suppressHydrationWarning>
			<body className="antialiased h-full font-sans bg-background text-foreground">
				<script dangerouslySetInnerHTML={{ __html: themeInitScript + railMaxInitScript }} />
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}

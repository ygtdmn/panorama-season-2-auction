import type { Metadata } from "next";
import { JetBrains_Mono, Hanken_Grotesk } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { themeInitScript } from "./components/ThemeProvider";
import { OG_IMAGE_URL, SITE_URL } from "@/lib/constants";

// Mono for the small technical labels; Hanken Grotesk as the clean sans/serif base.
const jetbrainsMono = JetBrains_Mono({
	subsets: ["latin"],
	weight: ["400", "500", "700"],
	display: "swap",
	variable: "--font-jetbrains-mono",
});

const hanken = Hanken_Grotesk({
	subsets: ["latin"],
	display: "swap",
	variable: "--font-hanken",
});

const description =
	"Bid on Season 2 of Panorama, an autonomous generative painting. A collaboration between Yigit Duman and DeltaSauce.";

export const metadata: Metadata = {
	metadataBase: new URL(SITE_URL),
	title: "Panorama Season 2 Auction",
	description,
	icons: {
		icon: [{ url: "/favicon.png" }],
		shortcut: "/favicon.png",
		apple: "/favicon.png",
	},
	authors: [{ name: "Yigit Duman" }, { name: "DeltaSauce" }],
	robots: "index, follow",
	openGraph: {
		title: "Panorama Season 2 Auction",
		description,
		type: "website",
		url: `${SITE_URL}/auction`,
		siteName: "Panorama",
		locale: "en_US",
		images: [{ url: OG_IMAGE_URL, width: 1920, height: 1080, alt: "Panorama", type: "image/jpeg" }],
	},
	twitter: {
		card: "summary_large_image",
		title: "Panorama Season 2 Auction",
		description,
		creator: "@yigitduman",
		images: [OG_IMAGE_URL],
	},
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" className={`${jetbrainsMono.variable} ${hanken.variable} h-full`} suppressHydrationWarning>
			<body className="antialiased h-full font-sans bg-background text-foreground">
				<script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}

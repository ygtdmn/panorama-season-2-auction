"use client";

import Link from "next/link";
import {
	getEvmNowUrl,
	GITHUB_URL,
	OPENSEA_COLLECTION_URL,
	PANORAMA_AUCTION_ADDRESS,
	SITE_URL,
} from "@/lib/constants";

const TERMINAL_URL = `${SITE_URL}/terminal`;
const X_YIGIT = "https://x.com/YigitDuman";
const X_DELTA = "https://x.com/deltasauce";

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
	return (
		<a href={href} target="_blank" rel="noreferrer" className="text-foreground underline hover:opacity-60 transition-opacity">
			{children}
		</a>
	);
}

/** The two artists, always linked to their profiles. */
function Yigit() {
	return <Ext href={X_YIGIT}>Yigit Duman</Ext>;
}
function Delta() {
	return <Ext href={X_DELTA}>DeltaSauce</Ext>;
}

/**
 * One editorial row: the heading sits in a left meta column and the content flows in the main
 * column. Stacked on mobile / small tablets (the read the mobile design nails); a two-track grid
 * from xl up, where the pane is wide enough to carry it. The heading is fluid so it never jumps.
 */
function Row({
	title,
	caption,
	children,
}: {
	title: string;
	caption?: string;
	children: React.ReactNode;
}) {
	// No rules anywhere. The heading sits in the left gutter; the content sits in a raised
	// surface panel. Separation is space and depth, not lines. Panels are spaced by the
	// container's flex gap.
	return (
		<section className="grid gap-x-8 gap-y-3 xl:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] xl:gap-x-12 3xl:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
			<div className="xl:pt-8">
				<h2 className="font-serif font-medium tracking-[-0.01em] text-foreground leading-tight text-pretty text-[clamp(1.3rem,1.05rem+0.7vw,1.7rem)]">
					{title}
				</h2>
				{caption && (
					<p className="mt-2 font-mono text-micro uppercase tracking-[0.16em] text-faint">
						{caption}
					</p>
				)}
			</div>
			<div className="min-w-0">
				{/* Card sized to its content — a consistent column of panels, not stretched
				    across the track (which would leave dead space inside each panel). */}
				<div className="bg-surface p-6 md:p-8 lg:p-10 max-w-[44rem] 3xl:max-w-[48rem]">
					{children}
				</div>
			</div>
		</section>
	);
}

export function AuctionIntro({
	durationHours,
	incrementPct,
	reserve,
	hardEndLabel,
}: {
	durationHours: number;
	incrementPct: number;
	reserve: string;
	hardEndLabel?: string;
}) {
	const faqs: { q: string; a: React.ReactNode }[] = [
		{
			q: "What is Panorama?",
			a: (
				<>
					An autonomous painting system by <Yigit />. It reads live market data and paints
					continuously: when the price of $PANO climbs the work brightens toward triumph, and when it
					falls it darkens toward ruin. The system composes each image; the artist curates and
					approves every one.
				</>
			),
		},
		{
			q: "What was Season 1?",
			a: "The first ninety paintings. One arrived each day and seamlessly extended the last, until the horizon became a single continuous panorama. Its subject was myth, and its mood was set entirely by the market.",
		},
		{
			q: "What am I bidding on?",
			a: (
				<>
					A Season 2 work. Season 2 is ninety works, #91 through #180, each depicting one technology.
					They are ordered chronologically, from the earliest invention at #91 to the most recent at
					#180, and each is rendered in whatever mood the market gives it. It is a collaboration
					between <Yigit /> and <Delta />. This auction sells all ninety at once.
				</>
			),
		},
		{
			q: "How are winners chosen?",
			a: "The ninety highest bids win. Every winner pays the same amount: the ninetieth-highest bid, called the clearing price. Anything you bid above it is refunded when the sale settles.",
		},
		{
			q: "What if I get outbid?",
			a: "The moment a higher bid pushes you out of the top ninety, your bid returns to your wallet. Nothing to claim, no waiting.",
		},
		{
			q: "Why bid more than the clearing price?",
			a: "Higher bids reveal first. The works reveal one per day. The top bid takes #1 and reveals on day one, and each slot down reveals a day later. Everyone still pays the clearing price, but a higher bid buys an earlier reveal.",
		},
		{
			q: "Can I bid on more than one?",
			a: "Yes. A wallet can hold up to four separate bids and win up to four paintings. Raise any of them at any time.",
		},
		{
			q: "When does bidding end?",
			a: `The sale runs about ${durationHours} hours. Any new bid in the last five minutes pushes the end out by ten minutes; a raise pushes it too once it adds at least ${incrementPct}% of the current floor. Extensions can add at most 24 hours past the scheduled close${hardEndLabel ? `, so the hard deadline is ${hardEndLabel}` : ""}. Sniping inside the normal window does not work; only the hard deadline is final.`,
		},
		{
			q: "What does it cost to enter?",
			a: `The reserve is ${reserve} ETH. Once all ninety slots are full, a new bid has to beat the lowest winning bid by at least ${incrementPct}%.`,
		},
		{
			q: "How do I get my painting?",
			a: "Winners are minted after the auction is settled. Each painting then reveals on its scheduled day, one per day, in bid order.",
		},
		{
			q: "Is my ETH safe if something goes wrong?",
			a: (
				<>
					Yes. Every recovery path is enforced by the contract and open to any wallet: settlement
					can be triggered by anyone seven days after close. If mint authorization or cap is
					unavailable then, anyone can switch the unminted bids to refunds; a collection-supply
					mismatch enables that recovery immediately. Cancelled sales refund permissionlessly,
					and the later emergency deadline remains a final backstop.{" "}
					<Link href="/recovery" className="text-foreground underline hover:opacity-60 transition-opacity">
						See the recovery page
					</Link>
					.
				</>
			),
		},
		{
			q: "What is $PANO?",
			a: (
				<>
					The ERC-20 token whose price drives the art&apos;s mood. When it rises the world ascends;
					when it falls it descends.{" "}
					<Ext href={TERMINAL_URL}>Trade $PANO on the terminal</Ext>.
				</>
			),
		},
	];

	return (
		<article className="pb-24">
			<div className="mx-auto w-full max-w-[1500px] 4xl:max-w-[1720px] px-5 md:px-10 xl:px-14 flex flex-col gap-5 md:gap-6">
				{/* The work — the deeper read; the hero above already carries the title. One
				    readable column, never split into newspaper columns. */}
				<Row title="The work">
					<div className="flex flex-col gap-5 font-sans text-base text-muted leading-relaxed">
						<p>
							Panorama is an autonomous painting system by <Yigit />. It reads live market data and
							turns it, without pause, into a continuous body of work. Nothing is drawn by hand: the
							system composes every image, and the artist curates and approves the ones that ship.
						</p>
						<p>
							The price of $PANO sets the mood. When it climbs, the work brightens toward triumph;
							when it falls, it darkens toward ruin. The same subject can read as a celebration or a
							wreck depending only on where the market sits the moment it is made. The price is never
							shown in the picture. You feel it as weather, not as a number.
						</p>
						<p>
							Season 2, made with <Delta />, is ninety works that trace the history of technology in
							order. #1 is the earliest invention and #90 the most recent; the numbers between run
							straight through human making, from the first tools to the machines of now. The sequence
							is fixed. Whether each invention arrives as a wonder or a warning is left to the market.
						</p>
					</div>
				</Row>

				{/* The sale — what it is, then how it works, in one panel. */}
				<Row title="The sale">
					<p className="font-sans text-base text-muted leading-relaxed">
						All ninety Season 2 paintings are sold at once, at a single price. You bid the most you
						would pay; the ninety highest bids win; and every winner pays the same amount, the
						ninetieth-highest bid. Anything you bid above it comes back when the sale settles. Winners
						are minted after settlement, and each painting reveals on its own day, highest bid first.
					</p>
					<ol className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2">
						{[
							{
								n: "01",
								t: "Bid your maximum",
								d: "Enter the most you would pay. Hold up to four bids and raise any of them at any time.",
							},
							{
								n: "02",
								t: "The top ninety win",
								d: "Only the ninety highest bids stay in. A higher bid pushes the lowest one out, and that bidder is refunded the same moment.",
							},
							{
								n: "03",
								t: "Everyone pays the floor",
								d: "At close, every winner pays the ninetieth-highest bid. Anything above it comes back to you.",
							},
							{
								n: "04",
								t: "Higher bids reveal first",
								d: "The top bid takes #1 and reveals on day one. Each slot down reveals a day later. Bid more to reveal sooner.",
							},
						].map((s) => (
							<li key={s.n} className="flex flex-col gap-2">
								<span className="font-mono text-micro tabular-nums text-faint">{s.n}</span>
								<h3 className="font-serif font-medium text-lg text-foreground leading-snug">{s.t}</h3>
								<p className="font-sans text-sm text-muted leading-relaxed">{s.d}</p>
							</li>
						))}
					</ol>
				</Row>

				{/* FAQ */}
				<Row title="Questions">
					<dl className="flex flex-col gap-7">
						{faqs.map((f) => (
							<div key={f.q} className="flex flex-col gap-1.5">
								<dt className="font-sans font-semibold text-sm text-foreground leading-snug">{f.q}</dt>
								<dd className="font-sans text-sm text-muted leading-relaxed">{f.a}</dd>
							</div>
						))}
					</dl>
				</Row>

				{/* Footer links */}
				<section className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-4">
					<Ext href={`${SITE_URL}/about`}>
						<span className="font-mono text-micro uppercase tracking-[0.16em]">The full story ↗</span>
					</Ext>
					<Ext href={TERMINAL_URL}>
						<span className="font-mono text-micro uppercase tracking-[0.16em]">Trade $PANO</span>
					</Ext>
					<Ext href={OPENSEA_COLLECTION_URL}>
						<span className="font-mono text-micro uppercase tracking-[0.16em]">OpenSea</span>
					</Ext>
					<Ext href={GITHUB_URL}>
						<span className="font-mono text-micro uppercase tracking-[0.16em]">GitHub ↗</span>
					</Ext>
					{PANORAMA_AUCTION_ADDRESS && (
						<Ext href={getEvmNowUrl(PANORAMA_AUCTION_ADDRESS)}>
							<span className="font-mono text-micro uppercase tracking-[0.16em]">Contract code ↗</span>
						</Ext>
					)}
					<span className="font-mono text-micro uppercase tracking-[0.14em] text-faint ml-auto">
						<Yigit /> × <Delta />
					</span>
				</section>
			</div>
		</article>
	);
}

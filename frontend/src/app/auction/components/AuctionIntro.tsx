"use client";

import Link from "next/link";
import {
	getBlockExplorerAddressUrl,
	OPENSEA_COLLECTION_URL,
	PANORAMA_NFT_ADDRESS,
	SITE_URL,
} from "@/lib/constants";
import { Label } from "./ui";

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
			<div className="mx-auto max-w-[860px] px-5 md:px-10">
				{/* The work — deeper read; the hero above already carries the title. */}
				<section className="pt-12 md:pt-16">
					<Label>The work</Label>
					<div className="mt-5 flex flex-col gap-5 font-sans text-base text-muted leading-relaxed max-w-[62ch]">
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
				</section>

				{/* What the sale is */}
				<section className="pt-12 md:pt-14 mt-12 md:mt-14 border-t border-line">
					<h2 className="font-serif font-medium text-xl md:text-2xl tracking-[-0.01em] text-foreground">
						This sale
					</h2>
					<p className="mt-5 font-sans text-base text-muted leading-relaxed max-w-[62ch]">
						All ninety Season 2 paintings are sold at once, at a single price. You bid the most you
						would pay; the ninety highest bids win; and every winner pays the same amount, the
						ninetieth-highest bid. Anything you bid above it comes back when the sale settles. Winners
						are minted after settlement, and each painting reveals on its own day, highest bid first.
					</p>
				</section>

				{/* How the sale works */}
				<section className="pt-12 md:pt-14 mt-12 md:mt-14 border-t border-line">
					<h2 className="font-serif font-medium text-xl md:text-2xl tracking-[-0.01em] text-foreground">
						How the sale works
					</h2>
					<ol className="mt-6 flex flex-col divide-y divide-line">
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
							<li key={s.n} className="flex gap-4 py-4 first:pt-0 last:pb-0">
								<span className="font-mono text-micro tabular-nums text-faint pt-1 w-6 shrink-0">
									{s.n}
								</span>
								<div className="flex flex-col gap-1.5">
									<h3 className="font-serif font-medium text-lg text-foreground leading-snug">{s.t}</h3>
									<p className="font-sans text-sm text-muted leading-relaxed">{s.d}</p>
								</div>
							</li>
						))}
					</ol>
				</section>

				{/* FAQ */}
				<section className="pt-12 md:pt-14 mt-12 md:mt-14 border-t border-line">
					<h2 className="font-serif font-medium text-xl md:text-2xl tracking-[-0.01em] text-foreground">
						Questions
					</h2>
					<dl className="mt-6 flex flex-col divide-y divide-line">
						{faqs.map((f) => (
							<div key={f.q} className="py-5 first:pt-0 grid md:grid-cols-[210px_1fr] gap-1.5 md:gap-6">
								<dt className="font-sans font-semibold text-sm text-foreground leading-snug">{f.q}</dt>
								<dd className="font-sans text-sm text-muted leading-relaxed">{f.a}</dd>
							</div>
						))}
					</dl>
				</section>

				{/* Footer links */}
				<section className="pt-10 mt-12 border-t border-line flex flex-wrap items-center gap-x-6 gap-y-2">
					<Ext href={`${SITE_URL}/about`}>
						<span className="font-mono text-micro uppercase tracking-[0.16em]">The full story ↗</span>
					</Ext>
					<Ext href={TERMINAL_URL}>
						<span className="font-mono text-micro uppercase tracking-[0.16em]">Trade $PANO</span>
					</Ext>
					<Ext href={OPENSEA_COLLECTION_URL}>
						<span className="font-mono text-micro uppercase tracking-[0.16em]">OpenSea</span>
					</Ext>
					{PANORAMA_NFT_ADDRESS && (
						<Ext href={getBlockExplorerAddressUrl(PANORAMA_NFT_ADDRESS)}>
							<span className="font-mono text-micro uppercase tracking-[0.16em]">Contract</span>
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

import { chromium } from "@playwright/test";

const OUT = "/tmp/claude-1000/-home-yigit-projects-panorama/a23ee09f-ad66-4e16-89ec-63e362016f5a/scratchpad";
const BASE = "http://localhost:5464";

const shots = [
	{ name: "home-hero", url: "/", scroll: 0, wait: 9000 },
	{ name: "home-system", url: "/", scroll: 1.0, wait: 7000 },
	{ name: "home-seasons", url: "/", scroll: 1.9, wait: 7000 },
	{ name: "about-top", url: "/about", scroll: 0, wait: 7000 },
	{ name: "about-moods", url: "/about", anchor: "moods", wait: 12000 },
	{ name: "about-seasons", url: "/about", anchor: "seasons", wait: 9000 },
	{ name: "tableau", url: "/tableau/23", scroll: 0, wait: 9000 },
	{ name: "tableau-record", url: "/tableau/23", scroll: 1.2, wait: 9000 },
];

const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_PATH,
});

for (const dark of [false, true]) {
	const ctx = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		colorScheme: dark ? "dark" : "light",
	});
	for (const s of shots) {
		// only shoot a subset in dark to keep it quick
		if (dark && !["home-hero", "about-moods", "tableau"].includes(s.name)) continue;
		const page = await ctx.newPage();
		await page.goto(BASE + s.url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
		try {
			if (s.anchor) {
				await page.evaluate((id) => document.getElementById(id)?.scrollIntoView(), s.anchor);
			} else if (s.scroll) {
				await page.evaluate((f) => window.scrollTo(0, window.innerHeight * f), s.scroll);
			}
		} catch {}
		await page.waitForTimeout(s.wait);
		await page.screenshot({ path: `${OUT}/${s.name}${dark ? "-dark" : ""}.png` });
		await page.close();
	}
	await ctx.close();
}
await browser.close();
console.log("done");

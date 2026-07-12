import { defineConfig, devices } from "@playwright/test";

// Anvil-backed end-to-end suite. globalSetup boots a local anvil chain (port 8546),
// deploys Panorama + controller + the Season 2 auction from the sibling Foundry project's
// forge artifacts (auto-detected in e2e/setup-chain.mjs), and writes e2e/.env.e2e.local;
// the webServer then starts `next dev` against that chain. Tests snapshot/revert anvil
// state, so they run serially.

export default defineConfig({
	testDir: "./e2e",
	timeout: 120_000,
	expect: { timeout: 20_000 },
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	globalTeardown: "./e2e/global-teardown.ts",
	use: {
		baseURL: "http://127.0.0.1:5471",
		trace: "retain-on-failure",
	},
	projects: [
		{ name: "desktop", use: { ...devices["Desktop Chrome"] }, grepInvert: /@mobile/ },
		{
			// Pixel 7 emulates mobile with chromium; iPhone presets need the webkit binary,
			// which neither local nor CI installs.
			name: "mobile",
			use: { ...devices["Pixel 7"] },
			grep: /@mobile/,
		},
	],
	webServer: {
		command: "node e2e/start-next.mjs",
		url: "http://127.0.0.1:5471/auction",
		reuseExistingServer: false,
		timeout: 180_000,
	},
});

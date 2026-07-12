// Boots the anvil chain + contracts (setup-chain.mjs), then starts the Next dev server
// with the env that deployment produced. Runs as Playwright's webServer command; Playwright
// launches this before globalSetup, so the chain bootstrap lives here rather than there.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupChain } from "./setup-chain.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));

await setupChain();

const env = { ...process.env };
for (const line of fs.readFileSync(path.join(dir, ".env.e2e.local"), "utf8").split("\n")) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (m) env[m[1]] = m[2];
}

const child = spawn("pnpm", ["exec", "next", "dev", "-p", "5471", "-H", "127.0.0.1"], {
	cwd: path.resolve(dir, ".."),
	env,
	stdio: "inherit",
});

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		child.kill();
		process.exit(0);
	});
}
child.on("exit", (code) => process.exit(code ?? 0));

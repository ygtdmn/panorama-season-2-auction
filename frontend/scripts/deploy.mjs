// `pnpm run deploy`: build and deploy the Worker with strict production env validation.
//
// PANORAMA_PRODUCTION=1 arms assertProductionEnv() (src/lib/env.ts, run from next.config.ts),
// so a deploy fails on a missing RPC/WalletConnect id or a set NEXT_PUBLIC_AUCTION_DEMO.
// The committed .env.production values are copied into process.env first, because a
// developer's .env.local outranks .env.production in the build and would otherwise ship
// (a keyed local RPC URL, for one). Variables already set in the shell still win.

import { spawn } from "node:child_process";
import fs from "node:fs";

const env = { ...process.env, PANORAMA_PRODUCTION: "1" };
for (const line of fs.readFileSync(new URL("../.env.production", import.meta.url), "utf8").split("\n")) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (m && process.env[m[1]] === undefined) env[m[1]] = m[2];
}

const child = spawn("vinext-cloudflare", ["deploy", ...process.argv.slice(2)], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));

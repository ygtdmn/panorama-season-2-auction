import fs from "node:fs";
import path from "node:path";
import { E2E_DIR } from "./helpers";

export default async function globalTeardown() {
	try {
		const pid = Number(fs.readFileSync(path.join(E2E_DIR, ".anvil.pid"), "utf8"));
		if (pid) process.kill(pid);
	} catch {
		// already gone
	}
}

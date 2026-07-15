// Production dependency audit against npm's bulk advisory endpoint.
//
// npm retired the quick-audit endpoint `pnpm audit` calls (HTTP 410 since mid-2026), and as
// of pnpm 11.13.0 no pnpm release speaks the replacement API. This script does what the
// retired step did: collect the EXACT installed production dependency closure from pnpm and
// ask the bulk advisory endpoint (the API npm's own CLI uses) about those versions. The
// endpoint filters by the versions sent, so anything it returns applies to this tree.
//
// Exit 0: no known advisories. Exit 1: advisories found, or the endpoint/tree read failed
// (an audit that silently skips is worse than a red build).

import { execSync } from "node:child_process";

const BULK_URL = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";

const tree = JSON.parse(
	execSync("pnpm list --prod --depth Infinity --json", {
		maxBuffer: 256 * 1024 * 1024,
	}).toString(),
);

/** name -> Set of exact installed versions across the whole prod closure. */
const packages = new Map();
function walk(deps) {
	if (!deps) return;
	for (const [name, info] of Object.entries(deps)) {
		// Registry packages only: links/workspace/file specs have no advisories to look up.
		if (info?.version && /^\d/.test(info.version)) {
			if (!packages.has(name)) packages.set(name, new Set());
			packages.get(name).add(info.version);
		}
		walk(info?.dependencies);
	}
}
for (const project of tree) walk(project.dependencies);

if (packages.size === 0) {
	console.error("No production packages found; refusing to report a clean audit.");
	process.exit(1);
}

const body = Object.fromEntries(
	[...packages].map(([name, versions]) => [name, [...versions]]),
);
const res = await fetch(BULK_URL, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});
if (!res.ok) {
	console.error(`Bulk advisory endpoint responded ${res.status}: ${await res.text()}`);
	process.exit(1);
}
const advisories = await res.json();

const affected = Object.keys(advisories).sort();
if (affected.length === 0) {
	console.log(`No known advisories across ${packages.size} production packages.`);
	process.exit(0);
}

let count = 0;
for (const name of affected) {
	const versions = [...(packages.get(name) ?? [])].join(", ");
	for (const a of advisories[name]) {
		count++;
		console.error(
			`${String(a.severity).toUpperCase().padEnd(9)} ${name}@${versions}  vulnerable: ${a.vulnerable_versions}\n          ${a.title}  ${a.url}`,
		);
	}
}
console.error(
	`\n${count} advisor${count === 1 ? "y" : "ies"} affecting ${affected.length} production package${affected.length === 1 ? "" : "s"}.`,
);
process.exit(1);

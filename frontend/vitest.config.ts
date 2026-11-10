import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	test: {
		include: ["test/unit/**/*.test.ts"],
		environment: "node",
	},
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
});

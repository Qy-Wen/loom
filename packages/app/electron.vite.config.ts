import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {
		build: {
			// @loom/agent is a TS-source workspace package: bundle it instead of
			// externalizing (node can't require its .ts entry point). Real npm deps
			// stay external and are required at runtime.
			externalizeDeps: { exclude: ["@loom/agent"] },
			rollupOptions: {
				input: { index: resolve(__dirname, "src/main/index.ts") },
			},
		},
	},
	preload: {
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, "src/preload/index.ts") },
			},
		},
	},
	renderer: {
		root: resolve(__dirname, "src/renderer"),
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, "src/renderer/index.html") },
			},
		},
		plugins: [react()],
	},
});

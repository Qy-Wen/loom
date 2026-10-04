import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {
		build: {
			// Workspace packages expose TypeScript source: bundle them instead of
			// externalizing (Node cannot load their .ts entry points). Real npm deps
			// stay external and are required at runtime.
			externalizeDeps: { exclude: ["@loom/agent", "@loom/core"] },
			rollupOptions: {
				input: { index: resolve(__dirname, "src/main/index.ts") },
				// Photon loads its wasm from the package directory. Keep the require external.
				external: ["@silvia-odwyer/photon-node"],
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
		// Keep this off the default 5173 so a second electron-vite app cannot
		// steal this dev server (that mix-up shows up as esbuild "Invalid loader").
		server: {
			port: 5273,
			strictPort: true,
		},
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, "src/renderer/index.html") },
			},
		},
		plugins: [react()],
	},
});

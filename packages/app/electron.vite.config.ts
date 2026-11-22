import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

/**
 * `pnpm dev` owns `out/`, where its windows load their preload script. `pnpm build:e2e` defaults to `out-e2e/`
 * so a test build can run alongside the dev server.
 */
export default defineConfig(({ mode }) => {
	const out = process.env.LOOM_BUILD_OUT?.trim() || (mode === "e2e" ? "out-e2e" : "out");
	const preloadInput: Record<string, string> = {
		index: resolve(__dirname, "src/preload/index.ts"),
		"dev-trace": resolve(__dirname, "src/preload/dev-trace.ts"),
	};
	return {
		main: {
			build: {
				outDir: resolve(__dirname, out, "main"),
				// Workspace packages expose TypeScript source: bundle them instead of
				// externalizing (Node cannot load their .ts entry points). Real npm deps
				// stay external and are required at runtime. Photon stays bundled because
				// its JS is bundler-oriented; its WASM resolves from the app's runtime dependency.
				externalizeDeps: { exclude: ["@loom/agent", "@loom/core", "@earendil-works/pi-codemode", "@silvia-odwyer/photon"] },
				rollupOptions: {
					input: { index: resolve(__dirname, "src/main/index.ts") },
				},
			},
		},
		preload: {
			build: {
				outDir: resolve(__dirname, out, "preload"),
				rollupOptions: {
					input: preloadInput,
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
				outDir: resolve(__dirname, out, "renderer"),
				emptyOutDir: true,
				rollupOptions: {
					input: { index: resolve(__dirname, "src/renderer/index.html"), "dev-trace": resolve(__dirname, "src/renderer/dev-trace.html"), ...(process.env.LOOM_E2E_PANELS === "1" ? { "panels-fixture": resolve(__dirname, "src/renderer/panels-fixture.html") } : {}) },
				},
			},
			plugins: [react()],
		},
	};
});

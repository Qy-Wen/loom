import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig(({ command }) => {
	const preloadInput: Record<string, string> = {
		index: resolve(__dirname, "src/preload/index.ts"),
	};
	// Isolated Electron trace acceptance may include the dev window; production still omits it.
	const trace = command === "serve" || process.env.LOOM_E2E_TRACE === "1";
	if (trace) {
		preloadInput["dev-trace"] = resolve(__dirname, "src/preload/dev-trace.ts");
	}
	return {
		main: {
			build: {
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
				rollupOptions: {
					input: { index: resolve(__dirname, "src/renderer/index.html"), ...(trace ? { "dev-trace": resolve(__dirname, "src/renderer/dev-trace.html") } : {}), ...(process.env.LOOM_E2E_PANELS === "1" ? { "panels-fixture": resolve(__dirname, "src/renderer/panels-fixture.html") } : {}) },
				},
			},
			plugins: [react()],
		},
	};
});

import { defineConfig } from "@playwright/test";

if (process.env.npm_lifecycle_event === "test:e2e:attach") {
	process.env.LOOM_CDP_URL ??= "http://127.0.0.1:9344";
}

const buildOut = process.env.LOOM_BUILD_OUT?.trim();

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.spec.ts",
	workers: 1,
	outputDir: buildOut && !process.env.LOOM_CDP_URL?.trim() ? `${buildOut}-results` : "./e2e-results",
});

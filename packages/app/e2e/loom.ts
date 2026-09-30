import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, chromium, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";

const require = createRequire(import.meta.url);
const appRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const CDP = process.env.LOOM_CDP_URL?.trim() || "http://127.0.0.1:9344";
const attach = Boolean(process.env.LOOM_CDP_URL?.trim());

export const test = base.extend<{ loomPage: Page }, { electronApp: ElectronApplication | null }>({
	electronApp: [
		async ({}, use) => {
			if (attach) {
				await use(null);
				return;
			}
			const main = join(appRoot, "out/main/index.js");
			if (!existsSync(main)) {
				throw new Error("Build the app first: pnpm --filter @loom/app build");
			}
			const e2eRoot = await mkdtemp(join(tmpdir(), "loom-e2e-"));
			try {
				const libraryRoot = join(e2eRoot, "library");
				const userData = join(e2eRoot, "user-data");
				await mkdir(libraryRoot);
				await mkdir(userData);
				await writeFile(join(userData, "last-library.json"), JSON.stringify({ rootPath: libraryRoot }));
				const app = await electron.launch({
					executablePath: require("electron") as string,
					args: [appRoot],
					env: {
						...process.env,
						LOOM_E2E: "1",
						LOOM_E2E_USER_DATA: userData,
						ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
					},
				});
				try {
					await use(app);
				} finally {
					await app.evaluate(({ app: electronApp }) => {
						electronApp.exit(0);
					}).catch(() => undefined);
					await app.close().catch(() => undefined);
				}
			} finally {
				await rm(e2eRoot, { recursive: true, force: true });
			}
		},
		{ scope: "worker" },
	],
	loomPage: async ({ electronApp }, use) => {
		if (attach) {
			const browser = await chromium.connectOverCDP(CDP);
			const page = browser.contexts().flatMap((context) => context.pages())[0];
			if (!page) throw new Error(`No Electron window at ${CDP}. Is pnpm dev running?`);
			await use(page);
			await browser.close();
			return;
		}
		if (!electronApp) throw new Error("Electron launch fixture missing");
		await use(await electronApp.firstWindow());
	},
});

export { expect };

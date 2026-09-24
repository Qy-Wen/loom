import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, chromium, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";

const require = createRequire(import.meta.url);
const appRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const CDP = process.env.LOOM_CDP_URL?.trim() || "http://127.0.0.1:9333";
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
			const app = await electron.launch({
				executablePath: require("electron") as string,
				args: [appRoot],
				env: {
					...process.env,
					LOOM_E2E: "1",
					ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
				},
			});
			await use(app);
			await app.evaluate(({ app: electronApp }) => {
				electronApp.exit(0);
			}).catch(() => undefined);
			await app.close().catch(() => undefined);
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

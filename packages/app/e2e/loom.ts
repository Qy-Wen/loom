import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, chromium, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";

/** Native OpenAI adapters require a key even for mock servers that ignore authentication. */
export async function saveChatEndpoint(page: Page, baseUrl: string, options: { model?: string; contextWindow?: number; input?: ("text" | "image")[] } = {}): Promise<void> {
	await page.evaluate(async ({ baseUrl, model, contextWindow, input }) => {
		const view = await window.loom.getChatSettings();
		const providers = view.config.providers.filter((provider) => provider.id !== "e2e-chat");
		providers.push({
			kind: "custom", id: "e2e-chat", enabled: true, baseUrl, api: "openai-completions", allowUnauthenticated: true,
			models: [{ id: model ?? "demo", reasoning: false, input: input ?? ["text"], contextWindow: contextWindow ?? 128_000, maxTokens: 8192 }],
		});
		await window.loom.saveChatSettings({ ...view.config, providers, default: { provider: "e2e-chat", modelId: model ?? "demo", thinkingLevel: "off" } });
		const unsubscribe = window.loom.onChatLoginPrompt((prompt) => {
			if (prompt.type === "secret") void window.loom.chatLoginResponse("e2e-placeholder");
		});
		try { await window.loom.chatLogin("e2e-chat", "api_key"); }
		finally { unsubscribe(); }
	}, { baseUrl, model: options.model, contextWindow: options.contextWindow, input: options.input });
}

const require = createRequire(import.meta.url);
const appRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const CDP = process.env.LOOM_CDP_URL?.trim() || "http://127.0.0.1:9344";
const attach = Boolean(process.env.LOOM_CDP_URL?.trim());

/**
 * Start an isolated Electron. A native context menu cannot be driven from a test and, left open while the app
 * is torn down, was seen to crash Electron on exit (macOS then shows a "quit unexpectedly" dialog that
 * stalls the run). So popup() answers at once as if the menu was dismissed.
 */
export async function launchTestElectron(userData: string): Promise<ElectronApplication> {
	if (!existsSync(join(appRoot, "out/main/index.js"))) throw new Error("Build the app first: pnpm --filter @loom/app build");
	const app = await electron.launch({
		executablePath: require("electron") as string,
		args: [appRoot],
		env: { ...process.env, LOOM_E2E: "1", LOOM_E2E_USER_DATA: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
	});
	await app.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (options?: { callback?: () => void }) {
			options?.callback?.();
		} as typeof Menu.prototype.popup;
	});
	return app;
}

// Each test owns its process, library, settings and renderer storage.
// Attach mode deliberately keeps using the existing application.
export const test = base.extend<{ loomPage: Page; electronApp: ElectronApplication | null }>({
	electronApp: [
		async ({}, use) => {
			if (attach) {
				await use(null);
				return;
			}
			const e2eRoot = await mkdtemp(join(tmpdir(), "loom-e2e-"));
			try {
				const libraryRoot = join(e2eRoot, "library");
				const userData = join(e2eRoot, "user-data");
				await mkdir(libraryRoot);
				await mkdir(userData);
				await writeFile(join(userData, "last-library.json"), JSON.stringify({ rootPath: libraryRoot }));
				await writeFile(join(userData, "general.json"), JSON.stringify({ language: "en", reopenLastLibrary: true }));
				const app = await launchTestElectron(userData);
				try {
					await use(app);
				} finally {
					await app.evaluate(({ app: electronApp }) => {
						electronApp.exit(0);
					}).catch(() => undefined);
					await app.close().catch(() => undefined);
				}
			} finally {
				await rm(e2eRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
			}
		},
		{ scope: "test" },
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

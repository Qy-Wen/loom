import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication } from "playwright";
import { expect, launchTestElectron, test } from "./loom.ts";

test("startup sandbox failure notice is restored after reload and restart until dismissed", async () => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated userData only");
	const root = await mkdtemp(join(tmpdir(), "loom-e2e-sandbox-notice-"));
	const userData = join(root, "user-data");
	const library = join(root, "library");
	const file = join(userData, "agent-sandbox.json");
	const reason = "WFP fence inactive during library recovery";
	const notice = { id: "startup-failure", reason };
	let app: ElectronApplication | undefined;
	const close = async () => {
		await app?.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
		await app?.close().catch(() => undefined);
		app = undefined;
	};
	try {
		await mkdir(userData); await mkdir(library);
		await writeFile(join(userData, "last-library.json"), JSON.stringify({ rootPath: library }));
		await writeFile(join(userData, "general.json"), JSON.stringify({ language: "en", reopenLastLibrary: true }));
		// Main-process fallback happened without a live renderer to receive IPC.
		await writeFile(file, JSON.stringify({ enabled: false, notice }));
		app = await launchTestElectron(userData);
		let page = await app.firstWindow();
		await expect(page.locator(".error-toast")).toContainText(reason);
		expect(await page.evaluate(() => window.loom.getAgentSandbox())).toBe(false);
		expect(await page.evaluate(() => window.loom.getProcessSandboxNotice())).toEqual(notice);
		await page.reload();
		await expect(page.locator(".error-toast")).toContainText(reason);
		await close();
		app = await launchTestElectron(userData);
		page = await app.firstWindow();
		await expect(page.locator(".error-toast")).toContainText(reason);
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = page.getByRole("dialog", { name: "Settings" });
		await settings.getByRole("tab", { name: "Agent", exact: true }).click();
		await expect(settings.getByRole("switch", { name: "Process sandbox" })).not.toBeChecked();
		await settings.getByRole("button", { name: "Close settings", exact: true }).click();
		await page.locator(".error-toast").getByRole("button", { name: "Dismiss", exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.loom.getProcessSandboxNotice())).toBe(null);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ enabled: false });
		await page.reload();
		await expect(page.locator(".shell")).toBeVisible();
		await expect(page.locator(".error-toast")).toHaveCount(0);
	} finally {
		await close();
		await rm(root, { recursive: true, force: true });
	}
});

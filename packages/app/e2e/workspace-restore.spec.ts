import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { expect, launchTestElectron, test } from "./loom.ts";

test("each library restores its view and active file and chat tabs after switching and restarting", async ({ testRoot, unopenedLibraryRoot }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated Electron required");
	test.setTimeout(60_000);
	const userData = join(testRoot, "user-data");
	const root = join(testRoot, "library");
	const removedPath = join(root, "Removed.md");
	await mkdir(userData);
	await mkdir(root);
	await writeFile(join(userData, "last-library.json"), JSON.stringify({ rootPath: root }));
	await writeFile(join(userData, "general.json"), JSON.stringify({ language: "en", reopenLastLibrary: true }));
	await writeFile(join(root, "Pinned.md"), "# Pinned");
	await writeFile(join(root, "Preview.md"), "# Preview");
	await writeFile(removedPath, "# Removed");

	let app: ElectronApplication | undefined;
	let page: Page;
	const view = (name: string) => page.getByRole("navigation", { name: "Workspace views" }).getByRole("button", { name, exact: true });
	const files = () => page.getByRole("tablist", { name: "Open files" });
	const chats = () => page.getByRole("tablist", { name: "Sessions" }).getByRole("tab");
	const open = async (path: string) => {
		await app!.evaluate(({ dialog }, path) => {
			const original = dialog.showOpenDialog;
			dialog.showOpenDialog = (async () => {
				dialog.showOpenDialog = original;
				return { canceled: false, filePaths: [path] };
			}) as typeof dialog.showOpenDialog;
		}, path);
		const button = page.getByRole("button", { name: "Open", exact: true });
		await button.click();
		await expect(button).toBeEnabled();
		await expect.poll(() => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath)).toBe(path);
	};

	try {
		app = await launchTestElectron(userData);
		page = await app.firstWindow();
		await page.locator(".library-sidebar .asset-row").filter({ hasText: "Pinned.md" }).click({ button: "middle" });
		await page.locator(".library-sidebar .asset-row").filter({ hasText: "Preview.md" }).click();
		await page.locator(".library-sidebar .asset-row").filter({ hasText: "Removed.md" }).click({ button: "middle" });
		await files().getByRole("tab", { name: "Preview.md", exact: true }).click();
		await expect(files().getByRole("tab", { selected: true })).toHaveAccessibleName("Preview.md");
		await expect(chats()).toHaveCount(1);
		const originalSession = (await page.evaluate(() => window.loom.listSessions()))[0]!.id;
		await page.getByRole("button", { name: "New session", exact: true }).click();
		await expect(chats()).toHaveCount(2);
		await chats().last().click();
		await expect(chats().last()).toHaveAttribute("aria-selected", "true");
		await view("Table").click();

		await open(unopenedLibraryRoot);
		await expect(view("Library")).toHaveAttribute("aria-pressed", "true");
		await expect(files()).toHaveCount(0);
		await expect(chats()).toHaveCount(1);
		await view("Graph").click();

		await open(root);
		await expect(view("Table")).toHaveAttribute("aria-pressed", "true");
		await expect(chats().last()).toHaveAttribute("aria-selected", "true");
		await view("Library").click();
		await expect(files().locator(".asset-tab-name")).toHaveText(["Pinned.md", "Preview.md", "Removed.md"]);
		await expect(files().getByRole("tab", { name: "Pinned.md", exact: true })).toHaveAccessibleDescription("Pinned tab");
		await expect(files().getByRole("tab", { selected: true })).toHaveAccessibleName("Preview.md");
		await expect(files().getByRole("tab", { selected: true })).toHaveAccessibleDescription(/Preview tab/);
		await view("Graph").click();
		await app.close();
		app = undefined;

		await rm(removedPath);
		app = await launchTestElectron(userData);
		page = await app.firstWindow();
		await expect(view("Graph")).toHaveAttribute("aria-pressed", "true");
		await expect(chats()).toHaveCount(2);
		await expect(chats().last()).toHaveAttribute("aria-selected", "true");
		await view("Library").click();
		await expect(files().locator(".asset-tab-name")).toHaveText(["Pinned.md", "Preview.md"]);
		await expect(files().getByRole("tab", { selected: true })).toHaveAccessibleName("Preview.md");

		await page.evaluate((id) => window.loom.deleteSession(id), originalSession);
		await page.reload();
		await expect(chats()).toHaveCount(1);
		await expect(chats().first()).toHaveAttribute("aria-selected", "true");
	} finally {
		await app?.close().catch(() => undefined);
	}
});

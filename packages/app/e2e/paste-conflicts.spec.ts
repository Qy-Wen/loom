import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ElectronApplication } from "playwright";
import { readMacFilePaths } from "../src/main/desktop/mac-file-clipboard.ts";
import { readWindowsFilePaths } from "../src/main/desktop/windows-file-clipboard.ts";
import { expect, test } from "./loom.ts";

const readNativeFilePaths = process.platform === "darwin" ? readMacFilePaths : readWindowsFilePaths;

async function forbidNativeDialogs(app: ElectronApplication) {
	await app.evaluate(({ dialog }) => {
		dialog.showMessageBox = (() => { throw new Error("Paste must use Loom's confirmation dialog"); }) as typeof dialog.showMessageBox;
	});
}

test("keyboard paste merges folders; Apply to All covers a mixed batch and resets for the next paste", async ({ loomPage: page, electronApp }, testInfo) => {
	test.skip(!electronApp, "isolated application required");
	test.setTimeout(60_000);
	await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	const files = {
		"from/note.md": "new note", "from/bundle/nested/inside.md": "new inside", "from/bundle/unique.md": "unique",
		"to/note.md": "old note", "to/bundle/nested/inside.md": "old inside", "to/bundle/retained.md": "retained",
	};
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(6);
	await forbidNativeDialogs(electronApp!);
	const sidebar = page.locator(".library-sidebar");
	await sidebar.getByRole("group", { name: "File display", exact: true }).getByRole("button", { name: "Icons", exact: true }).click();
	const browser = page.locator(".folder-browser");
	const tile = (name: string) => browser.locator(".browser-tile").filter({ has: page.locator(".browser-tile-name", { hasText: new RegExp(`^${name}$`) }) });
	await tile("from").dblclick();
	await browser.locator(".browser-scroll").focus();
	await page.keyboard.press("ControlOrMeta+a");
	await expect(browser.locator(".browser-tile.selected")).toHaveCount(2);
	await page.keyboard.press("ControlOrMeta+c");
	if (process.platform === "darwin" || process.platform === "win32") {
		await expect.poll(async () => (await readNativeFilePaths()).sort()).toEqual([join(root, "from", "bundle"), join(root, "from", "note.md")]);
	}
	await sidebar.locator(".library-root-button").click();
	await tile("to").dblclick();
	await browser.locator(".browser-scroll").focus();
	await page.keyboard.press("ControlOrMeta+v");
	const dialog = page.locator(".confirmation-dialog");
	const checkbox = dialog.getByRole("checkbox", { name: "Apply to all conflicts in this paste" });
	await expect(dialog).toHaveAttribute("data-tone", "warning");
	await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(checkbox).toBeFocused();
	await page.keyboard.press("Space");
	await expect(checkbox).toBeChecked();
	await page.keyboard.press("Shift+Tab");
	await expect(dialog.getByRole("button", { name: "Keep Both", exact: true })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(checkbox).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath("paste-conflict.png") });
	await dialog.getByRole("button", { name: "Keep Both", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.some((asset) => asset.relativePath === "to/bundle/nested/inside 2.md")).toBe(true);
	expect(await readFile(join(root, "to/note 2.md"), "utf8")).toBe("new note");
	expect(await readFile(join(root, "to/note.md"), "utf8")).toBe("old note");
	expect(await readFile(join(root, "to/bundle/unique.md"), "utf8")).toBe("unique");
	expect(await readFile(join(root, "to/bundle/retained.md"), "utf8")).toBe("retained");
	await expect(tile("note 2.md")).toBeVisible();
	// Another paste asks again; Cancel must stop before any new copy is made.
	await browser.locator(".browser-scroll").focus();
	await page.keyboard.press("ControlOrMeta+v");
	await expect(dialog).toBeVisible();
	await expect(checkbox).not.toBeChecked();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(9);
});

test("Replace applies to nested files; unchecked choices ask again, and external Cancel leaves sources untouched", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated application required");
	const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	for (const [path, content] of Object.entries({ "source/bundle/a.md": "new a", "source/bundle/b.md": "new b", "target/bundle/a.md": "old a", "target/bundle/b.md": "old b" })) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(4);
	await forbidNativeDialogs(electronApp!);
	const pasted = page.evaluate(async () => {
		await window.loom.copyLibraryItems([], ["source/bundle"], false);
		return window.loom.pasteFromClipboard("target");
	});
	const dialog = page.locator(".confirmation-dialog");
	await expect(dialog).toHaveAccessibleName(/a\.md.*already exists\./);
	await expect(dialog.getByRole("checkbox")).not.toBeChecked();
	await dialog.getByRole("button", { name: "Replace", exact: true }).click();
	await expect(dialog).toHaveAccessibleName(/b\.md.*already exists\./);
	await expect(dialog.getByRole("checkbox")).not.toBeChecked();
	await dialog.getByRole("button", { name: "Keep Both", exact: true }).click();
	expect((await pasted)?.cancelled).toBe(false);
	await expect(dialog).toHaveCount(0);
	expect(await readFile(join(root, "target/bundle/a.md"), "utf8")).toBe("new a");
	expect(await readFile(join(root, "target/bundle/b.md"), "utf8")).toBe("old b");
	expect(await readFile(join(root, "target/bundle/b 2.md"), "utf8")).toBe("new b");
	const external = join(dirname(root), "external");
	await mkdir(external);
	await writeFile(join(external, "a.md"), "outside");
	const cancelled = page.evaluate(({ path }) => window.loom.placePathsInto([path], "target/bundle", true), { path: join(external, "a.md") });
	await expect(dialog).toHaveAccessibleName(/a\.md.*already exists\./);
	await dialog.getByRole("checkbox").check();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	expect((await cancelled).cancelled).toBe(true);
	await expect(dialog).toHaveCount(0);
	expect(await readFile(join(external, "a.md"), "utf8")).toBe("outside");
	expect(await readFile(join(root, "target/bundle/a.md"), "utf8")).toBe("new a");
});

test("library paste follows the latest native clipboard write", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp || (process.platform !== "darwin" && process.platform !== "win32"), "native file clipboard required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	const root = (await snapshot()).rootPath!;
	const external = join(dirname(root), "external.md");
	await mkdir(join(root, "target"));
	await writeFile(join(root, "library.md"), "copied in Loom");
	await writeFile(external, "copied outside Loom");

	const sidebar = page.locator(".library-sidebar");
	const internal = sidebar.locator(".asset-row").filter({ hasText: "library.md" });
	const target = sidebar.locator(".folder-main").filter({ hasText: "target" });
	await internal.click();
	await page.keyboard.press("ControlOrMeta+x");
	await expect(internal).toHaveClass(/\bcut\b/);

	await electronApp!.evaluate(({ clipboard }, path) => {
		(clipboard as typeof clipboard & { _writeFilesForTesting: (paths: string[]) => void })._writeFilesForTesting([path]);
	}, external);
	await target.click();
	await page.keyboard.press("ControlOrMeta+v");
	await expect.poll(async () => (await snapshot()).assets.some((asset) => asset.relativePath === "target/external.md")).toBe(true);
	await expect(internal).not.toHaveClass(/\bcut\b/);
	expect(await readFile(join(root, "library.md"), "utf8")).toBe("copied in Loom");
	expect(await readFile(join(root, "target", "external.md"), "utf8")).toBe("copied outside Loom");

	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			this.items.find((item) => item.label === "Paste" && item.enabled)?.click();
			options?.callback?.();
		};
	});
	await internal.click();
	await page.keyboard.press("ControlOrMeta+c");
	await expect.poll(() => readNativeFilePaths()).toEqual([join(root, "library.md")]);
	const assetId = (await snapshot()).assets.find((asset) => asset.relativePath === "library.md")!.assetId;
	await page.evaluate((id) => window.loom.renameAsset(id, "renamed.md"), assetId);
	await target.click({ button: "right" });
	await expect.poll(async () => (await snapshot()).assets.some((asset) => asset.relativePath === "target/renamed.md")).toBe(true);
	expect(await readFile(join(root, "target", "renamed.md"), "utf8")).toBe("copied in Loom");
});

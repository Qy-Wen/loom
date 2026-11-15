import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ElectronApplication } from "playwright";
import { expect, test } from "./loom.ts";

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
	const pasted = page.evaluate(() => window.loom.pasteLibraryItems([], ["source/bundle"], "target", false));
	const dialog = page.locator(".confirmation-dialog");
	await expect(dialog).toHaveAccessibleName(/a\.md.*already exists\./);
	await expect(dialog.getByRole("checkbox")).not.toBeChecked();
	await dialog.getByRole("button", { name: "Replace", exact: true }).click();
	await expect(dialog).toHaveAccessibleName(/b\.md.*already exists\./);
	await expect(dialog.getByRole("checkbox")).not.toBeChecked();
	await dialog.getByRole("button", { name: "Keep Both", exact: true }).click();
	expect((await pasted).cancelled).toBe(false);
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

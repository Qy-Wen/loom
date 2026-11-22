import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("blank-area menus create and name Markdown files in the sidebar root and browsed folder", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	await expect.poll(async () => (await snapshot()).rootPath).toBeTruthy();
	const root = (await snapshot()).rootPath!;
	await mkdir(join(root, "notes"));
	await writeFile(join(root, "Untitled.md"), "keep the existing note");
	await expect.poll(async () => (await snapshot()).assets.map((asset) => asset.relativePath)).toContain("Untitled.md");
	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			this.items.find((item) => item.label === "New Markdown File" && item.enabled)?.click();
			options?.callback?.();
		};
	});

	const sidebar = page.locator(".library-sidebar");
	const blank = sidebar.locator(".asset-list");
	const bounds = (await blank.boundingBox())!;
	await blank.click({ button: "right", position: { x: bounds.width / 2, y: bounds.height - 10 } });
	const listEditor = sidebar.locator(".rename-editor input");
	await expect(listEditor).toBeFocused();
	await expect(listEditor).toHaveValue("Untitled 2.md");
	await listEditor.fill("root note.md");
	await listEditor.press("Enter");
	await expect.poll(async () => (await snapshot()).assets.map((asset) => asset.relativePath)).toContain("root note.md");
	expect(await readFile(join(root, "Untitled.md"), "utf8")).toBe("keep the existing note");
	expect(await readFile(join(root, "root note.md"), "utf8")).toBe("");

	await sidebar.getByRole("button", { name: "Icons", exact: true }).click();
	await sidebar.locator(".folder-main").filter({ hasText: /^notes$/ }).click();
	const browser = page.locator(".folder-browser");
	await expect(browser.locator(".browser-crumb.current")).toHaveText("notes");
	await browser.locator(".browser-empty").click({ button: "right" });
	const tileEditor = browser.locator(".browser-tile-rename input");
	await expect(tileEditor).toBeFocused();
	await expect(tileEditor).toHaveValue("Untitled.md");
	await tileEditor.fill("folder note.md");
	await tileEditor.press("Enter");
	await expect.poll(async () => (await snapshot()).assets.map((asset) => asset.relativePath)).toContain("notes/folder note.md");
	await expect(browser.locator(".browser-crumb.current")).toHaveText("notes");
	expect(await readFile(join(root, "notes", "folder note.md"), "utf8")).toBe("");
});

for (const display of ["Icons", "List"] as const) {
	test(`${display.toLowerCase()} mode creates folders at the library root from the sidebar blank area`, async ({ loomPage: page, electronApp }) => {
		test.skip(!electronApp, "isolated library required");
		test.setTimeout(60_000);
		await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
		const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
		await mkdir(join(root, "parent", "child"), { recursive: true });
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders.length).toBe(2);
		await electronApp!.evaluate(({ Menu }) => {
			Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
				this.items.find((item) => item.label === "New Folder" && item.enabled)?.click();
				options?.callback?.();
			};
		});

		const sidebar = page.locator(".library-sidebar");
		const browser = page.locator(".folder-browser");
		await sidebar.getByRole("button", { name: display, exact: true }).click();
		await sidebar.locator(".folder-main").filter({ hasText: /^child$/ }).click();
		if (display === "Icons") await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
		const crumbs = await browser.locator(".browser-crumb").allTextContents();

		const blank = sidebar.locator(".asset-list");
		const bounds = await blank.boundingBox();
		await blank.click({ button: "right", position: { x: bounds!.width / 2, y: bounds!.height - 10 } });
		const editor = sidebar.locator(".rename-editor input");
		await expect(editor).toBeFocused();
		await expect(editor).toHaveValue("New Folder");
		await expect(browser.locator(".browser-tile-rename")).toHaveCount(0);
		await editor.fill("created-at-root");
		await editor.press("Enter");
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders).toEqual(["created-at-root", "parent", "parent/child"]);
		await expect(sidebar.locator(".folder-row.selected")).toHaveText("created-at-root");
		if (display === "Icons") {
			await expect(browser.locator(".browser-crumb")).toHaveText(crumbs);

			// The browser's blank area still creates inside the folder being browsed.
			await sidebar.locator(".folder-main").filter({ hasText: /^child$/ }).click();
			await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
			await browser.locator(".browser-empty").click({ button: "right" });
			const browserEditor = browser.locator(".browser-tile-rename input");
			await expect(browserEditor).toBeFocused();
			await expect(editor).toHaveCount(0);
			await browserEditor.fill("created-in-child");
			await browserEditor.press("Enter");
			await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders).toEqual(["created-at-root", "parent", "parent/child", "parent/child/created-in-child"]);
			await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
		}
	});
}

for (const source of ["folder menu", "shortcut"] as const) {
	test(`icon-mode tree ${source} creates and names folders in the tree`, async ({ loomPage: page, electronApp }) => {
		test.skip(!electronApp, "isolated library required");
		test.setTimeout(60_000);
		await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
		const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
		await mkdir(join(root, "parent", "child"), { recursive: true });
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders.length).toBe(2);
		await electronApp!.evaluate(({ Menu }) => {
			Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
				this.items.find((item) => item.label === "New Folder" && item.enabled)?.click();
				options?.callback?.();
			};
		});
		const sidebar = page.locator(".library-sidebar");
		const browser = page.locator(".folder-browser");
		await sidebar.getByRole("button", { name: "Icons", exact: true }).click();
		await sidebar.locator(".folder-main").filter({ hasText: /^child$/ }).click();
		await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
		const crumbs = await browser.locator(".browser-crumb").allTextContents();
		if (source === "folder menu") {
			// A collapsed ancestor must open to show the new folder without navigating away.
			await sidebar.locator(".folder-row").filter({ hasText: /^parent$/ }).getByRole("button", { name: "Collapse folder" }).click();
			await sidebar.locator(".folder-main").filter({ hasText: /^parent$/ }).click({ button: "right" });
		} else {
			await sidebar.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+N`);
		}
		const editor = sidebar.locator(".rename-editor input");
		await expect(editor).toBeFocused();
		await expect(editor).toHaveValue("New Folder");
		await expect(browser.locator(".browser-tile-rename")).toHaveCount(0);
		await expect(browser.locator(".browser-crumb")).toHaveText(crumbs);
		await editor.fill("created-in-tree");
		await editor.press("Enter");
		const expected = source === "folder menu" ? "parent/created-in-tree" : "parent/child/created-in-tree";
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders).toContain(expected);
		await expect(editor).toHaveCount(0);
		await expect(sidebar.locator(".folder-row.selected")).toHaveText("created-in-tree");
		await expect(browser.locator(".browser-crumb")).toHaveText(crumbs);
	});
}

test("folder menu leads with New Folder, New Markdown File and New Canvas, and creates Markdown inside the folder", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	await expect.poll(async () => (await snapshot()).rootPath).toBeTruthy();
	const root = (await snapshot()).rootPath!;
	await mkdir(join(root, "notes"));
	await expect.poll(async () => (await snapshot()).folders).toContain("notes");
	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			const labels = this.items.filter((item) => item.type !== "separator").map((item) => item.label);
			(globalThis as { menuLabels?: string[] }).menuLabels = labels;
			this.items.find((item) => item.label === "New Markdown File" && item.enabled)?.click();
			options?.callback?.();
		};
	});

	const sidebar = page.locator(".library-sidebar");
	await sidebar.locator(".folder-main").filter({ hasText: /^notes$/ }).click({ button: "right" });
	await expect.poll(async () => (await electronApp!.evaluate(() => (globalThis as { menuLabels?: string[] }).menuLabels))?.slice(0, 3))
		.toEqual(["New Folder", "New Markdown File", "New Canvas"]);
	const editor = sidebar.locator(".rename-editor input");
	await expect(editor).toBeFocused();
	await editor.fill("inside.md");
	await editor.press("Enter");
	await expect.poll(async () => (await snapshot()).assets.map((asset) => asset.relativePath)).toContain("notes/inside.md");
});

test("file menus create Markdown and canvas files next to the clicked file", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	await expect.poll(async () => (await snapshot()).rootPath).toBeTruthy();
	const root = (await snapshot()).rootPath!;
	await mkdir(join(root, "notes"));
	await writeFile(join(root, "notes", "existing.md"), "# Existing");
	const paths = async () => (await snapshot()).assets.map((asset) => asset.relativePath);
	await expect.poll(paths).toContain("notes/existing.md");
	const sidebar = page.locator(".library-sidebar");
	const browser = page.locator(".folder-browser");
	const folder = sidebar.locator(".folder-row").filter({ hasText: /^notes$/ });
	await expect(folder).toBeVisible();
	const expand = folder.getByRole("button", { name: "Expand folder" });
	if (await expand.count()) await expand.click();

	const cases = [
		{ label: "New Markdown File", file: sidebar.locator(".asset-row").filter({ hasText: "existing.md" }), editor: sidebar.locator(".rename-editor input"), stem: "sibling note", extension: "md" },
		{ label: "New Canvas", file: browser.locator(".browser-tile").filter({ hasText: "existing.md" }), editor: browser.locator(".browser-tile-rename input"), stem: "sibling canvas", extension: "canvas" },
	];
	for (const { label, file, editor, stem, extension } of cases) {
		if (extension === "canvas") {
			await sidebar.getByRole("button", { name: "Icons", exact: true }).click();
			await sidebar.locator(".folder-main").filter({ hasText: /^notes$/ }).click();
		}
		await electronApp!.evaluate(({ Menu }, label) => {
			Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
				const start = this.items.findIndex((item) => item.label === "New Folder");
				const items = this.items.slice(start, start + 3);
				(globalThis as { createLabels?: string[] }).createLabels = items.map((item) => item.label);
				items.find((item) => item.label === label && item.enabled)?.click();
				options?.callback?.();
			};
		}, label);
		await file.click({ button: "right" });
		await expect(editor).toBeFocused();
		await editor.fill(`${stem}.${extension}`);
		await editor.press("Enter");
		await expect.poll(paths).toContain(`notes/${stem}.${extension}`);
		expect(await electronApp!.evaluate(() => (globalThis as { createLabels?: string[] }).createLabels))
			.toEqual(["New Folder", "New Markdown File", "New Canvas"]);
	}
});

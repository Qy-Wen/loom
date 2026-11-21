import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("table and graph open an asset in the selected library display", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const rootPath = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(rootPath).toBeTruthy();
	const root = (await rootPath())!;
	await mkdir(join(root, "folder"));
	await writeFile(join(root, "start.md"), "# Start");
	await writeFile(join(root, "folder", "target.md"), "# Target");
	const controls = page.locator(".library-view-controls");
	const button = (name: string) => controls.getByRole("button", { name, exact: true });
	const row = page.locator(".asset-table tbody tr").filter({ hasText: "target.md" });
	const node = page.locator('.graph-node[aria-label="target.md"]');
	const target = page.getByRole("textbox", { name: "Edit target.md", exact: true });
	const overlay = page.getByRole("dialog", { name: "File preview" });
	await page.locator(".library-sidebar .asset-row").filter({ hasText: "start.md" }).click();

	await button("Table").click();
	await page.getByRole("button", { name: "+ Add field", exact: true }).click();
	const field = page.getByPlaceholder("Field name");
	await field.fill("Notes");
	await field.press("Enter");
	const notes = row.getByRole("textbox", { name: "Notes", exact: true });
	await notes.dblclick();
	await expect(notes).toBeFocused();
	await expect(button("Table")).toHaveAttribute("aria-pressed", "true");

	for (const mode of ["List", "Icons"]) {
		await button(mode).click();
		for (const view of ["Table", "Graph"]) {
			await button(view).click();
			const item = view === "Table" ? row.getByText("target.md", { exact: true }) : node.locator(".graph-node-outline");
			await item.click();
			await expect(button(view)).toHaveAttribute("aria-pressed", "true");
			await expect(view === "Table" ? row : node).toHaveClass(/selected/);
			await item.dblclick();
			await expect(button("Library")).toHaveAttribute("aria-pressed", "true");
			await expect(button(mode)).toHaveAttribute("aria-pressed", "true");
			await expect(target).toBeVisible();
			if (mode === "List") {
				await expect(page.getByRole("tab", { selected: true })).toHaveAccessibleName("target.md");
			} else {
				await expect(overlay.locator(".preview-overlay-title")).toHaveText("folder/target.md");
				await expect(overlay.locator(".preview-overlay-bar > .asset-file-icon")).toHaveAttribute("data-kind", "markdown");
				await overlay.getByRole("button", { name: "Close preview", exact: true }).click();
			}
		}
	}

	await button("Table").click();
	await row.press("Enter");
	await expect(overlay.locator(".preview-overlay-title")).toHaveText("folder/target.md");
	await overlay.getByRole("button", { name: "Close preview", exact: true }).click();
	await button("Graph").click();
	await node.press("Enter");
	await expect(overlay.locator(".preview-overlay-title")).toHaveText("folder/target.md");
});

test("canvas and Markdown previews can be pinned and unpinned from the tab menu", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const rootPath = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(rootPath).toBeTruthy();
	const root = (await rootPath())!;
	await writeFile(join(root, "Board.canvas"), JSON.stringify({ nodes: [], edges: [] }));
	for (const name of ["First.md", "Second.md", "Third.md"]) await writeFile(join(root, name), "# Note");
	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			this.items.find((item) => ["Pin Tab", "Unpin Tab", "Open in new tab", "New Canvas"].includes(item.label) && item.enabled)?.click();
			options?.callback?.();
		};
	});

	const file = (name: string) => page.locator(".library-sidebar .asset-row").filter({ has: page.getByText(name, { exact: true }) });
	const strip = page.getByRole("tablist", { name: "Open files" });
	const names = strip.locator(".asset-tab-name");
	const tab = (name: string) => strip.getByRole("tab", { name, exact: true });
	const selected = strip.getByRole("tab", { selected: true });

	for (const name of ["First.md", "Board.canvas", "Second.md"]) {
		await file(name).click();
		await expect(names).toHaveText([name]);
		await expect(selected).toHaveText(name);
		await expect(selected).toHaveAccessibleDescription(/Preview tab/);
		await expect(selected).toHaveCSS("font-style", "normal");
		const icon = selected.locator(".asset-file-icon");
		await expect(icon).toBeVisible();
		await expect(icon).toHaveAttribute("data-kind", name.endsWith(".canvas") ? "canvas" : "markdown");
		await expect(selected.locator(".asset-tab-pin")).toHaveCount(0);
	}

	const list = page.locator(".library-sidebar .asset-list");
	const bounds = (await list.boundingBox())!;
	await list.click({ button: "right", position: { x: bounds.width / 2, y: bounds.height - 10 } });
	const rename = list.locator(".rename-editor input");
	await rename.fill("New board");
	await rename.press("Enter");
	await expect(names).toHaveText(["New board.canvas"]);
	await expect(selected).toHaveAccessibleDescription(/Preview tab/);
	await file("Second.md").click();
	await expect(names).toHaveText(["Second.md"]);

	await file("Board.canvas").dblclick();
	await tab("Board.canvas").dblclick();
	await expect(tab("Board.canvas")).toHaveAccessibleDescription(/Preview tab/);
	await tab("Board.canvas").click({ button: "right" });
	await expect(tab("Board.canvas")).toHaveAccessibleDescription("Pinned tab");
	await expect(tab("Board.canvas")).toHaveCSS("font-style", "normal");
	await expect(tab("Board.canvas").locator(".asset-file-icon")).toHaveAttribute("data-kind", "canvas");
	await expect(tab("Board.canvas").locator(".asset-tab-pin")).toBeVisible();
	await expect(page.getByRole("region", { name: "Canvas Board.canvas" })).toBeVisible();

	await file("First.md").click();
	await tab("Board.canvas").click({ button: "right" });
	await expect(tab("Board.canvas")).toHaveAccessibleDescription(/Preview tab/);
	await expect(tab("Board.canvas").locator(".asset-tab-pin")).toHaveCount(0);
	await expect(tab("First.md")).toHaveAccessibleDescription(/Preview tab/);
	await expect(names).toHaveText(["Board.canvas", "First.md"]);
	await expect(selected).toHaveAccessibleName("First.md");
	await file("Second.md").click();
	await expect(names).toHaveText(["Board.canvas", "Second.md"]);
	await expect(selected).toHaveAccessibleName("Second.md");

	await tab("Board.canvas").click({ button: "right" });
	await expect(tab("Board.canvas")).toHaveAccessibleDescription("Pinned tab");
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		const pinnedColor = await tab("Board.canvas").evaluate((element) => getComputedStyle(element).color);
		await expect(tab("Second.md")).toHaveCSS("color", pinnedColor);
	}
	await page.emulateMedia({ colorScheme: null });
	const tabWidths = () => strip.locator(".asset-tab").evaluateAll((elements) =>
		elements.map((element) => element.getBoundingClientRect().width));
	const widthsBeforeSelection = await tabWidths();
	await tab("Board.canvas").click();
	await expect(selected).toHaveAccessibleName("Board.canvas");
	await expect.poll(tabWidths).toEqual(widthsBeforeSelection);
	await tab("Second.md").press("Shift+F10");
	await expect(tab("Second.md")).toHaveAccessibleDescription("Pinned tab");
	await expect(tab("Second.md")).toBeFocused();
	await expect(selected).toHaveAccessibleName("Board.canvas");
	await file("Third.md").click();
	await expect(names).toHaveText(["Board.canvas", "Third.md", "Second.md"]);
	await file("First.md").click({ button: "right" });
	await expect(names).toHaveText(["Board.canvas", "Third.md", "First.md", "Second.md"]);
	await expect(selected).toHaveAccessibleName("First.md");
	await expect(selected).toHaveAccessibleDescription(/Preview tab/);
	await expect(selected.locator(".asset-tab-pin")).toHaveCount(0);
	await file("Board.canvas").click({ button: "right" });
	await expect(names).toHaveText(["Board.canvas", "Third.md", "First.md", "Second.md"]);
	await expect(selected).toHaveAccessibleName("Board.canvas");
	await expect(selected).toHaveAccessibleDescription("Pinned tab");
	await file("Third.md").click({ button: "middle" });
	await expect(names).toHaveText(["Board.canvas", "Third.md", "First.md", "Second.md"]);
	await expect(tab("Third.md")).toHaveAccessibleDescription("Pinned tab");
});

test("files dragged from the tree into the tab strip open as previews", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const rootPath = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(rootPath).toBeTruthy();
	const root = (await rootPath())!;
	await writeFile(join(root, "Pinned.md"), "# Pinned");
	await writeFile(join(root, "Dragged.md"), "# Dragged");

	const file = (name: string) => page.locator(".library-sidebar .asset-row").filter({ hasText: name });
	const strip = page.getByRole("tablist", { name: "Open files" });
	const pinned = strip.getByRole("tab", { name: "Pinned.md", exact: true });
	const dragged = strip.getByRole("tab", { name: "Dragged.md", exact: true });
	await file("Pinned.md").click({ button: "middle" });
	await expect(pinned).toHaveAccessibleDescription("Pinned tab");
	await file("Dragged.md").dragTo(pinned, { targetPosition: { x: 4, y: 10 } });
	await expect(dragged).toHaveAttribute("aria-selected", "true");
	await expect(dragged).toHaveAccessibleDescription(/Preview tab/);
	await expect(dragged.locator(".asset-tab-pin")).toHaveCount(0);
	await expect(pinned).toHaveAccessibleDescription("Pinned tab");
});

test("asset tabs can be opened, moved and closed with their files", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(45000);
	const previousRoot = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	const root = await mkdtemp(join(tmpdir(), "loom-tabs-e2e-"));
	const fixture = new URL("../../core/tests/fixtures/media/still.png", import.meta.url);
	await mkdir(join(root, "one")); await mkdir(join(root, "two"));
	await copyFile(fixture, join(root, "alpha.png"));
	await copyFile(fixture, join(root, "beta.png"));
	await copyFile(fixture, join(root, "one", "same.png"));
	await copyFile(fixture, join(root, "two", "same.png"));
	await writeFile(join(root, "notes.md"), "# hello\n");
	async function open(path: string) {
		await electronApp!.evaluate(({ dialog }, path) => {
			const original = dialog.showOpenDialog;
			dialog.showOpenDialog = (async () => {
				dialog.showOpenDialog = original;
				return { canceled: false, filePaths: [path] };
			}) as typeof dialog.showOpenDialog;
		}, path);
		await loomPage.evaluate(() => window.loom.openLibrary());
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath).toBe(path);
	}
	const strip = loomPage.getByRole("tablist", { name: "Open files" });
	const names = strip.locator(".asset-tab-name");
	const tree = loomPage.locator(".library-sidebar, aside").first();
	const file = (name: string) => tree.locator(".asset-row").filter({ hasText: name }).first();
	// A real mouse drag: the welcome page only takes a drop that started from a tree row.
	async function dragToWorkbench(name: string) {
		const from = (await file(name).boundingBox())!;
		const to = (await loomPage.locator(".workbench").boundingBox())!;
		await loomPage.mouse.move(from.x + 20, from.y + from.height / 2);
		await loomPage.mouse.down();
		await loomPage.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
		await expect(loomPage.locator(".welcome.drop-ready")).toBeVisible();
		await loomPage.mouse.up();
	}
	try {
		await open(root);
		await expect(strip).toHaveCount(0);

		await file("alpha.png").click();
		await expect(strip.getByRole("tab")).toHaveCount(1);
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("alpha.png");

		// A plain click replaces the preview.
		await file("beta.png").click();
		await expect(strip.getByRole("tab")).toHaveCount(1);
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("beta.png");

		// Right-click moves the tree focus but must not change the shown tab.
		await file("alpha.png").click({ button: "right" });
		await loomPage.keyboard.press("Escape");
		await expect(strip.getByRole("tab")).toHaveCount(1);
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("beta.png");

		// Middle-click opens a new tab next to it.
		await file("alpha.png").click({ button: "middle" });
		await expect(names).toHaveText(["beta.png", "alpha.png"]);
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("alpha.png");

		// A file that is already open is shown, not duplicated.
		await file("beta.png").click();
		await expect(strip.getByRole("tab")).toHaveCount(2);
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("beta.png");

		await strip.getByRole("tab", { name: "alpha.png" }).click();
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("alpha.png");
		await expect(file("beta.png")).toHaveClass(/selected/);

		// Two open files with the same name show their folder.
		const same = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.filter((asset) => asset.filename === "same.png");
		expect(same).toHaveLength(2);
		for (const folder of ["one", "two"]) {
			await tree.locator(".folder-row").filter({ hasText: folder }).locator(".folder-chevron").click();
		}
		await tree.locator(".asset-row").filter({ hasText: "same.png" }).nth(0).click({ button: "middle" });
		await tree.locator(".asset-row").filter({ hasText: "same.png" }).nth(1).click({ button: "middle" });
		await expect(strip.getByRole("tab", { name: "same.png · one" })).toHaveCount(1);
		await expect(strip.getByRole("tab", { name: "same.png · two" })).toHaveCount(1);
		await expect(strip.getByRole("tab")).toHaveCount(4);

		// A single click switches tabs and keeps the tree selection and folder collapsed.
		const oneFolder = tree.locator(".folder-row").filter({ hasText: "one" });
		const oneTab = strip.getByRole("tab", { name: "same.png · one" });
		const oneFile = tree.locator(".asset-row").filter({ has: loomPage.locator('[data-tooltip="one/same.png"]') });
		await oneFolder.locator(".folder-chevron").click();
		await oneTab.click();
		await expect(oneTab).toHaveAttribute("aria-selected", "true");
		await expect(oneTab.locator(".asset-file-icon")).toHaveAttribute("data-kind", "image");
		await expect(oneFolder).toHaveClass(/selected/);
		await expect(oneFile).toHaveCount(0);

		// Double-clicking the active tab expands its folder and locates its file.
		await oneTab.dblclick();
		await expect(oneFile).toHaveClass(/selected/);
		await expect(oneFile).toBeInViewport();

		// The tab menu can locate a file while another tab stays active.
		const twoTab = strip.getByRole("tab", { name: "same.png · two" });
		await twoTab.click();
		await oneFolder.locator(".folder-chevron").click();
		await expect(oneFile).toHaveCount(0);
		await electronApp!.evaluate(({ Menu }) => {
			const popup = Menu.prototype.popup;
			Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
				const locate = this.items.find((item) => item.label === "Locate in File Tree" && item.enabled);
				if (!locate) return popup.call(this, options);
				locate.click();
				options?.callback?.();
			};
		});
		await oneTab.click({ button: "right" });
		await expect(oneFile).toHaveClass(/selected/);
		await expect(oneFile).toBeInViewport();
		await expect(twoTab).toHaveAttribute("aria-selected", "true");

		await file("notes.md").click({ button: "middle" });
		await expect(strip.getByRole("tab")).toHaveCount(5);
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("notes.md");
		const titleBar = loomPage.locator(".window-bar");
		await expect(loomPage.locator(".workbench").getByRole("tablist", { name: "Open files" })).toBeVisible();
		await expect(strip).toHaveCSS("-webkit-app-region", "no-drag");
		const tabRow = loomPage.locator(".workbench > :is(.window-bar.mac, .asset-tabs)");
		const dockHeading = loomPage.locator(".dock-band :is(.panel-tabs, .work-panel-title):visible").first();
		await expect(tabRow).toHaveCSS("border-bottom-width", "1px");
		await expect(dockHeading).toHaveCSS("border-bottom-width", "1px");
		const tabRowBounds = (await tabRow.boundingBox())!;
		const dockHeadingBounds = (await dockHeading.boundingBox())!;
		expect(tabRowBounds.y + tabRowBounds.height).toBe(dockHeadingBounds.y + dockHeadingBounds.height);
		const windowButtons = loomPage.locator(":is(.mac-window-actions, .window-bar.overlay) > button");
		expect(await windowButtons.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))))
			.toEqual(["Open", "Collapse sidebar", "Back", "Forward"]);
		if (await titleBar.evaluate((node) => node.classList.contains("mac"))) {
			await expect(titleBar).toHaveCSS("-webkit-app-region", "none");
			const workbenchDrag = titleBar.locator(".window-drag-space");
			await expect(workbenchDrag).toHaveCSS("-webkit-app-region", "drag");
			const divider = loomPage.getByRole("separator", { name: "Resize asset library" });
			const dividerBox = (await divider.boundingBox())!;
			expect(dividerBox.y).toBe(0);
			expect(dividerBox.height).toBeCloseTo(await loomPage.evaluate(() => innerHeight), 0);
			const sidebarDrag = tree.locator(".library-window-drag");
			await expect(sidebarDrag).toHaveCSS("-webkit-app-region", "drag");
			const actions = loomPage.locator(".mac-window-actions");
			await expect(actions.getByRole("button")).toHaveCount(4);
			await expect(actions).toHaveCSS("column-gap", "4px");
			await expect(titleBar.locator(":scope > button")).toHaveCount(0);
			const actionsBox = (await actions.boundingBox())!;
			expect(actionsBox.x).toBe(86);
			const actionsEnd = actionsBox.x + actionsBox.width;
			expect((await sidebarDrag.boundingBox())!.x).toBeGreaterThanOrEqual(actionsEnd);
			const collapse = actions.getByRole("button", { name: "Collapse sidebar" });
			await collapse.focus();
			await collapse.press("Enter");
			expect(await actions.boundingBox()).toEqual(actionsBox);
			await expect(titleBar).toHaveCSS("padding-left", "198px");
			expect((await workbenchDrag.boundingBox())!.x).toBeGreaterThanOrEqual(actionsEnd);
			await expect(divider).toBeHidden();
			const expand = actions.getByRole("button", { name: "Expand sidebar" });
			await expect(expand).toBeFocused();
			await expand.press("Enter");
			await expect(collapse).toBeFocused();
			await expect(titleBar).toHaveCSS("padding-left", "9px");
			expect(await actions.boundingBox()).toEqual(actionsBox);
		} else {
			await expect(titleBar).toHaveCSS("-webkit-app-region", "drag");
			await expect(titleBar).toHaveCSS("height", "32px");
			const dragSpace = (await titleBar.locator(".window-drag-space").boundingBox())!;
			expect(dragSpace.width).toBeGreaterThanOrEqual(40);
			expect(dragSpace.y + dragSpace.height).toBeLessThanOrEqual(tabRowBounds.y);
		}
		const notesEditor = loomPage.getByRole("textbox", { name: "Edit notes.md", exact: true });
		await expect(notesEditor.getByRole("heading", { level: 1 })).toContainText("hello");

		// Dragging a tab reorders it; the active tab stays active.
		await expect(names).toHaveText(["beta.png", "alpha.png", "same.png · one", "same.png · two", "notes.md"]);
		const tab = (name: string) => strip.getByRole("tab", { name, exact: true });
		const closeButton = (name: string) => strip.getByRole("button", { name: `Close ${name}`, exact: true });
		await tab("beta.png").dragTo(closeButton("notes.md"));
		await expect(names).toHaveText(["alpha.png", "same.png · one", "same.png · two", "notes.md", "beta.png"]);
		await tab("notes.md").dragTo(tab("alpha.png"), { targetPosition: { x: 4, y: 10 } });
		await expect(names).toHaveText(["notes.md", "alpha.png", "same.png · one", "same.png · two", "beta.png"]);
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("notes.md");
		// A tab dropped on the file tree is not a file move.
		await strip.getByRole("tab", { name: "notes.md" }).dragTo(tree.locator(".folder-main").filter({ hasText: "one" }).first());
		await expect(names).toHaveCount(5);
		expect((await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.find((asset) => asset.filename === "notes.md")!.relativePath).toBe("notes.md");
		// Put the tabs back in the order the rest of the test expects.
		await tab("notes.md").dragTo(closeButton("beta.png"));
		await expect(names).toHaveText(["alpha.png", "same.png · one", "same.png · two", "beta.png", "notes.md"]);

		// Closing the active tab shows a neighbour.
		await strip.getByRole("button", { name: "Close notes.md" }).click();
		await expect(strip.getByRole("tab")).toHaveCount(4);
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("beta.png");

		// Middle-click on a tab closes it.
		await strip.getByRole("tab", { name: "beta.png" }).click({ button: "middle" });
		await expect(strip.getByRole("tab")).toHaveCount(3);
		for (let i = 0; i < 2; i++) await strip.getByRole("button", { name: "Close same.png" }).first().click();
		await expect(names).toHaveText(["alpha.png"]);

		// Dragging files from the tree onto the strip opens them as tabs.
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		await file("beta.png").click();
		await expect(names).toHaveText(["alpha.png", "beta.png"]);
		const lastTab = (await strip.locator(".asset-tab").last().boundingBox())!;
		const tabBar = (await tabRow.boundingBox())!;
		const source = (await file("notes.md").boundingBox())!;
		const blankX = (lastTab.x + lastTab.width + tabBar.x + tabBar.width) / 2;
		const tabY = tabBar.y + tabBar.height / 2;
		const sourceY = source.y + source.height / 2;
		expect(blankX).toBeGreaterThan(lastTab.x + lastTab.width + 20);
		await loomPage.mouse.move(source.x + 20, sourceY);
		await loomPage.mouse.down();
		try {
			// Enter the empty strip from below without crossing an existing tab.
			await loomPage.mouse.move(blankX, sourceY, { steps: 8 });
			await loomPage.mouse.move(blankX, tabY, { steps: 8 });
			await loomPage.mouse.move(blankX - 1, tabY);
			await expect(strip.locator(".asset-tab.drop-after .asset-tab-name")).toHaveText("beta.png");
		} finally {
			await loomPage.mouse.up();
		}
		await expect(names).toHaveText(["alpha.png", "beta.png", "notes.md"]);
		await expect(strip.locator(".asset-tab.drop-after")).toHaveCount(0);
		await expect(titleBar.locator(".window-drag-space")).toBeVisible();
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("notes.md");
		await expect(file("notes.md")).toHaveClass(/selected/);

		// A file that is already open moves instead of duplicating.
		await file("notes.md").dragTo(strip.getByRole("tab", { name: "beta.png" }), { targetPosition: { x: 4, y: 10 } });
		await expect(names).toHaveText(["alpha.png", "notes.md", "beta.png"]);
		// A folder has no view, so the strip does not take it.
		await tree.locator(".folder-main").filter({ hasText: "one" }).first().dragTo(strip.getByRole("tab", { name: "beta.png" }));
		await expect(strip.getByRole("tab")).toHaveCount(3);
		// With no tab open, dropping on the workbench opens the file.
		for (const name of ["alpha.png", "beta.png", "notes.md"]) await strip.getByRole("button", { name: `Close ${name}` }).click();
		await expect(strip).toHaveCount(0);
		await dragToWorkbench("alpha.png");
		await expect(names).toHaveText(["alpha.png"]);
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("alpha.png");
		await expect(loomPage.locator(".welcome")).toHaveCount(0);

		// Several selected files all open as tabs, in tree order, and the first is shown.
		// Ctrl/Cmd-clicking builds the selection while keeping the current tab.
		await file("beta.png").click({ modifiers: [modifier] });
		await file("notes.md").click({ modifiers: [modifier] });
		for (const name of ["alpha.png", "beta.png", "notes.md"]) await expect(file(name)).toHaveClass(/selected/);
		await expect(names).toHaveText(["alpha.png"]);
		await file("beta.png").dragTo(strip.getByRole("tab", { name: "alpha.png" }), { targetPosition: { x: 4, y: 10 } });
		await expect(names).toHaveText(["alpha.png", "beta.png", "notes.md"]);
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("alpha.png");

		// Removing a file externally closes its tab through the library watcher.
		await rm(join(root, "alpha.png"));
		await expect(names).toHaveText(["beta.png", "notes.md"]);
		await expect(strip.getByRole("tab", { selected: true })).toHaveAccessibleName("beta.png");

		// Switching library forgets every tab.
		await file("beta.png").click();
		await expect(strip.getByRole("tab")).toHaveCount(2);
		await open(previousRoot);
		await expect(strip).toHaveCount(0);
	} finally {
		await open(previousRoot).catch(() => undefined);
		await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
});

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test } from "./loom.ts";

test("view tabs keep their icons and show only the active label without moving the display controls", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated renderer required");
	for (const width of [180, 240, 320]) {
		await loomPage.evaluate((width) => localStorage.setItem("loom.layout.libraryWidth", String(width)), width);
		await loomPage.reload();
		const views = loomPage.getByRole("navigation", { name: "Workspace views" });
		const tabs = views.locator(".library-view-tabs");
		const controls = loomPage.locator(".library-view-controls");
		const display = controls.getByRole("group", { name: "File display", exact: true });
		await expect(views.getByRole("group", { name: "File display", exact: true })).toHaveCount(0);
		await expect(views).toBeVisible();
		expect(await tabs.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))).toEqual(["Table", "Graph", "Library"]);
		const initialPrimary = (await views.boundingBox())!;
		const initialDisplay = (await display.boundingBox())!;
		for (const name of ["Table", "Graph", "Library"]) {
			const button = tabs.getByRole("button", { name, exact: true });
			await button.click();
			await expect(button).toHaveAttribute("aria-pressed", "true");
			await expect(tabs.locator('[aria-pressed="true"]')).toHaveCount(1);
			await expect(tabs.locator("button.active > span")).toHaveText([name]);
			await expect(button.locator("span")).toHaveCSS("opacity", "1");
			await expect(display).toBeVisible();
			const nav = (await controls.boundingBox())!;
			for (const item of await tabs.getByRole("button").all()) {
				const bounds = (await item.boundingBox())!;
				await expect(item).not.toHaveAttribute("title");
				await expect(item.locator("svg")).toBeVisible();
				await expect(item.locator("svg")).toHaveAttribute("aria-hidden", "true");
				const icon = (await item.locator("svg").boundingBox())!;
				expect([icon.width, icon.height]).toEqual([14, 14]);
				expect(icon.x).toBeGreaterThanOrEqual(bounds.x - 1);
				expect(icon.x + icon.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
				if (await item.getAttribute("aria-pressed") === "true") {
					const label = (await item.locator("span").boundingBox())!;
					expect(await item.locator("span").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
					expect(icon.x + icon.width).toBeLessThanOrEqual(label.x);
					expect(label.x + label.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
					expect(Math.abs(icon.y + icon.height / 2 - label.y - label.height / 2)).toBeLessThan(1);
				} else {
					expect(bounds.width).toBe(24);
					await expect(item.locator("span")).toBeHidden();
				}
				expect(bounds.x + bounds.width).toBeLessThanOrEqual(nav.x + nav.width + 1);
			}
			await expect(display.locator('[aria-pressed="true"]')).toHaveCount(1);
			const library = (await tabs.getByRole("button", { name: "Library", exact: true }).boundingBox())!;
			const list = (await display.getByRole("button", { name: "List", exact: true }).boundingBox())!;
			const icons = (await display.getByRole("button", { name: "Icons", exact: true }).boundingBox())!;
			expect(list.width).toBe(24);
			expect(icons.width).toBe(24);
			expect(Math.abs(list.width - list.height)).toBeLessThan(1);
			const primary = (await views.boundingBox())!;
			const modes = (await display.boundingBox())!;
			expect(primary).toEqual(initialPrimary);
			expect(modes).toEqual(initialDisplay);
			expect(modes.x).toBeGreaterThan(primary.x + primary.width);
			expect(list.x).toBeGreaterThanOrEqual(library.x + library.width);
			expect(icons.x).toBeGreaterThanOrEqual(list.x + list.width);
			expect(icons.x + icons.width).toBeLessThanOrEqual(nav.x + nav.width);
			expect(list.y).toBe(library.y);
			expect(icons.y).toBe(library.y);
		}
	}
});

test("all five tab options show the same hover tooltip as the top toolbar", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated renderer required");
	await loomPage.evaluate(() => localStorage.setItem("loom.layout.libraryWidth", "180"));
	await loomPage.reload();
	const controls = loomPage.locator(".library-view-controls");
	const tooltipStyle = (element: Element) => {
		const style = getComputedStyle(element, "::after");
		return { background: style.backgroundColor, color: style.color, fontSize: style.fontSize, borderRadius: style.borderRadius, padding: style.padding };
	};
	const expectedStyle = await loomPage.locator(".window-bar button[aria-label]").first().evaluate(tooltipStyle);
	for (const name of ["Table", "Graph", "Library", "List", "Icons"]) {
		const button = controls.getByRole("button", { name, exact: true });
		await expect(button).not.toHaveAttribute("title");
		await button.hover();
		await expect.poll(() => button.evaluate((element) => getComputedStyle(element, "::after").opacity)).toBe("1");
		expect(await button.evaluate((element) => getComputedStyle(element, "::after").content)).toBe(JSON.stringify(name));
		expect(await button.evaluate(tooltipStyle)).toEqual(expectedStyle);
	}
	const first = controls.getByRole("button", { name: "Table", exact: true });
	const last = controls.getByRole("button", { name: "Icons", exact: true });
	expect(await first.evaluate((element) => getComputedStyle(element, "::after").left)).toBe("0px");
	expect(await last.evaluate((element) => getComputedStyle(element, "::after").right)).toBe("0px");
	await loomPage.mouse.move(600, 20);
	await first.focus();
	await loomPage.keyboard.press("Tab");
	const graph = controls.getByRole("button", { name: "Graph", exact: true });
	await expect(graph).toBeFocused();
	await expect.poll(() => graph.evaluate((element) => getComputedStyle(element, "::after").opacity)).toBe("1");
});

test("both tab groups animate their selection and respect reduced motion", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated renderer required");
	await loomPage.emulateMedia({ reducedMotion: "no-preference" });
	const controls = loomPage.locator(".library-view-controls");
	const tabs = controls.locator(".library-view-tabs");
	const display = controls.getByRole("group", { name: "File display", exact: true });
	await expect(controls).toBeVisible();
	const bounds = (await controls.boundingBox())!;
	for (const [group, name] of [[tabs, "Table"], [display, "Icons"]] as const) {
		const animated = await group.evaluate(async (element, name) => {
			getComputedStyle(element, "::before").transform;
			(element.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement).click();
			await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
			getComputedStyle(element, "::before").transform;
			return element.getAnimations({ subtree: true }).some((animation) => animation.playState === "running");
		}, name);
		expect(animated).toBe(true);
		await expect(group.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
		await expect.poll(async () => group.evaluate((element) => {
			const style = getComputedStyle(element, "::before");
			const indicatorX = element.getBoundingClientRect().x + parseFloat(style.left) + new DOMMatrixReadOnly(style.transform).m41;
			const selected = element.querySelector('button[aria-pressed="true"]')!.getBoundingClientRect();
			return Math.abs(indicatorX - selected.x) + Math.abs(parseFloat(style.width) - selected.width);
		})).toBeLessThan(0.1);
		expect(await controls.boundingBox()).toEqual(bounds);
	}
	await loomPage.emulateMedia({ reducedMotion: "reduce" });
	for (const [group, name] of [[tabs, "Library"], [display, "List"]] as const) {
		expect(await group.evaluate((element) => getComputedStyle(element, "::before").transitionDuration)).toBe("0s");
		await group.getByRole("button", { name, exact: true }).click();
		await expect(group.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
		expect(await group.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
	}
});

test("independent display controls preserve the active view and the file tree owns sorting and search", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await Promise.all(["alpha.md", "beta.md"].map((name) => writeFile(join(root, name), `# ${name}`)));
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(2);
	await loomPage.evaluate(async () => {
		const { assets } = await window.loom.getLibrarySnapshot();
		await window.loom.setFavorite(assets[0]!.assetId, true);
	});
	const sidebar = loomPage.locator(".library-sidebar");
	const workspace = sidebar.locator(".library-view-controls");
	const header = sidebar.locator(".library-files-header");
	const files = sidebar.locator(".asset-list");
	await expect(sidebar.locator(".library-header, .workspace-heading")).toHaveCount(0);
	await expect(workspace.getByRole("group", { name: "File display" })).toBeVisible();
	await expect(workspace.locator(".file-sort")).toHaveCount(0);
	await expect(workspace.getByRole("button", { name: "Search files", exact: true })).toHaveCount(0);
	await expect(header.locator(".file-heading-title > span")).toHaveText([basename(root), "2"]);
	await expect(header.locator(".library-files-name")).toHaveAttribute("title", root);
	await expect(header.locator(".library-display-tabs")).toHaveCount(0);
	await expect(sidebar.locator(".library-shortcuts")).toBeVisible();
	const shortcuts = (await sidebar.locator(".library-shortcuts-pane").boundingBox())!;
	expect((await header.boundingBox())!.y).toBeGreaterThanOrEqual(shortcuts.y + shortcuts.height);
	await header.getByRole("button", { name: "Sort files", exact: true }).click();
	await header.getByRole("menuitemradio", { name: "Name", exact: true }).click();
	await expect(files.locator(".asset-name")).toHaveText(["alpha.md", "beta.md"]);
	await header.getByRole("button", { name: "Ascending", exact: true }).click();
	await expect(files.locator(".asset-name")).toHaveText(["beta.md", "alpha.md"]);
	await header.getByRole("button", { name: "Search files", exact: true }).click();
	const search = header.getByRole("searchbox");
	await expect(search).toBeFocused();
	await search.fill("alpha");
	await expect(header.locator(".file-heading-title > span")).toHaveText([basename(root), "1"]);
	await expect(files.locator(".asset-name")).toHaveText(["alpha.md"]);
	await search.press("Escape");
	await expect(search).toHaveCount(0);
	await expect(header.locator(".file-heading-title > span")).toHaveText([basename(root), "2"]);
	await workspace.getByRole("button", { name: "Icons", exact: true }).click();
	await expect(header.locator(".file-sort")).toHaveCount(0);
	await expect(header.getByRole("button", { name: "Search files", exact: true })).toHaveCount(0);
	await expect(header.locator(".file-heading-title > *")).toHaveText([basename(root), "2"]);
	await workspace.getByRole("button", { name: "List", exact: true }).click();
	await expect(header.getByRole("button", { name: "Sort files", exact: true })).toBeVisible();
	await workspace.getByRole("button", { name: "Icons", exact: true }).click();
	for (const view of ["Table", "Graph"]) {
		await workspace.getByRole("button", { name: view, exact: true }).click();
		await expect(workspace.getByRole("group", { name: "File display", exact: true })).toBeVisible();
		await workspace.getByRole("button", { name: view === "Table" ? "List" : "Icons", exact: true }).click();
		await expect(workspace.getByRole("button", { name: view, exact: true })).toHaveAttribute("aria-pressed", "true");
	}
	await workspace.getByRole("button", { name: "Library", exact: true }).click();
	await expect(workspace.getByRole("button", { name: "Icons", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("folder heading stays aligned when switching list and icon modes", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await writeFile(join(root, "sample.md"), "# sample");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(1);
	const sidebar = loomPage.locator(".library-sidebar");
	const workspace = sidebar.locator(".library-view-controls");
	const geometry = () => sidebar.evaluate((element) => {
		const heading = element.querySelector(".library-files-heading")!.getBoundingClientRect();
		const title = element.querySelector(".library-files-name")!.getBoundingClientRect();
		const tree = element.querySelector(".asset-list")!.getBoundingClientRect();
		return { headingY: heading.y, headingHeight: heading.height, titleX: title.x, titleY: title.y, treeY: tree.y };
	});
	for (const shortcuts of [false, true]) {
		if (shortcuts) {
			await loomPage.evaluate(async () => {
				const { assets } = await window.loom.getLibrarySnapshot();
				await window.loom.setFavorite(assets[0]!.assetId, true);
				await window.loom.addAssetTag(assets[0]!.assetId, "Picked");
			});
			await expect(sidebar.locator(".library-shortcuts")).toBeVisible();
		}
		for (const width of [180, 320]) {
			await loomPage.evaluate((width) => localStorage.setItem("loom.layout.libraryWidth", String(width)), width);
			await loomPage.reload();
			await expect(workspace.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
			const listGeometry = await geometry();
			for (const mode of ["Icons", "List", "Icons", "List"]) {
				await workspace.getByRole("button", { name: mode, exact: true }).click();
				await expect.poll(geometry).toEqual(listGeometry);
			}
		}
	}
});

test("folder heading preserves its name and fits long names beside the tools", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const previousRoot = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	const folderName = "My Creative Workspace with a long folder name";
	const root = join(previousRoot, folderName);
	await mkdir(root);
	await electronApp!.evaluate(({ dialog }, path) => {
		const original = dialog.showOpenDialog;
		dialog.showOpenDialog = (async () => {
			dialog.showOpenDialog = original;
			return { canceled: false, filePaths: [path] };
		}) as typeof dialog.showOpenDialog;
	}, root);
	await loomPage.evaluate(() => window.loom.openLibrary());
	await loomPage.evaluate(() => localStorage.setItem("loom.layout.libraryWidth", "180"));
	await loomPage.reload();
	const sidebar = loomPage.locator(".library-sidebar");
	const name = sidebar.locator(".library-files-name");
	await expect(sidebar.locator(".library-header")).toHaveCount(0);
	await expect(name).toHaveText(folderName);
	await expect(name).toHaveAttribute("title", root);
	await expect(name).toHaveCSS("font-size", "12px");
	await expect(sidebar.locator(".library-files-heading .file-heading-title")).toHaveCSS("align-items", "baseline");
	await expect(name).toHaveCSS("text-transform", "none");
	await expect(name).toHaveCSS("text-overflow", "ellipsis");
	expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
	const bounds = (await name.boundingBox())!;
	const count = (await sidebar.locator(".library-files-heading .file-heading-title > span:last-child").boundingBox())!;
	const tools = (await sidebar.locator(".library-files-heading .file-heading-tools").boundingBox())!;
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(count.x);
	expect(count.x + count.width).toBeLessThanOrEqual(tools.x);
});

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test } from "./loom.ts";

test("the library divider folds live and can reopen during the same drag", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated renderer required");
	await loomPage.emulateMedia({ reducedMotion: "no-preference" });
	await loomPage.evaluate(() => localStorage.setItem("loom.layout.libraryWidth", "180"));
	await loomPage.reload();
	const shell = loomPage.locator(".shell");
	const divider = loomPage.getByRole("separator", { name: "Resize asset library" });
	const toggle = loomPage.locator(".sidebar-toggle");
	const togglePanel = toggle.locator(".sidebar-toggle-panel");
	const views = loomPage.getByRole("navigation", { name: "Workspace views" });
	const viewIcons = loomPage.locator(".library-view-controls button svg");
	const viewIconPositions = () => viewIcons.evaluateAll((icons) => icons.map((icon) => icon.getBoundingClientRect().x));
	const savedCollapse = () => loomPage.evaluate(() => localStorage.getItem("loom.layout.libraryCollapsed"));
	const foldingLayout = () => shell.evaluate((element) => {
		const transition = element.getAnimations().find((animation) =>
			animation instanceof CSSTransition && animation.transitionProperty === "--library-open-progress");
		if (!transition?.effect) return null;
		transition.pause();
		transition.currentTime = Number(transition.effect.getTiming().duration) / 2;
		const width = Number.parseFloat(getComputedStyle(element).gridTemplateColumns);
		const viewsLeft = element.querySelector(".library-views")!.getBoundingClientRect().left;
		transition.play();
		return { width, viewsLeft };
	});
	await expect(shell).toHaveCSS("--library-width", "200px");
	const macActions = loomPage.locator(".mac-window-actions");
	if (await macActions.isVisible()) {
		const actionsBox = (await macActions.boundingBox())!;
		expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual((await divider.boundingBox())!.x);
	}
	await divider.dblclick();
	await expect(shell).toHaveCSS("--library-width", "240px");
	await expect.poll(async () => (await divider.boundingBox())?.x).toBeCloseTo(240, 0);
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(togglePanel).toHaveCount(0);
	const initialViews = (await views.boundingBox())!;

	const handle = (await divider.boundingBox())!;
	const x = handle.x + handle.width / 2;
	const y = handle.y + handle.height / 2;
	await loomPage.mouse.move(x, y);
	await loomPage.mouse.down();
	try {
		await loomPage.mouse.move(x - 39, y, { steps: 5 });
		await expect(shell).toHaveCSS("--library-width", "201px");
		const beforeMinimum = await viewIconPositions();
		await loomPage.mouse.move(x - 40, y, { steps: 5 });
		await expect(shell).toHaveCSS("--library-width", "200px");
		const narrowedViews = (await views.boundingBox())!;
		expect(narrowedViews.x).toBe(initialViews.x);
		expect(narrowedViews.width).toBeLessThan(initialViews.width);
		const atMinimum = await viewIconPositions();
		expect(atMinimum).toHaveLength(5);
		for (const [index, position] of atMinimum.entries()) {
			expect(Math.abs(position - beforeMinimum[index]!)).toBeLessThanOrEqual(1);
		}
		await expect(divider).toBeVisible();
		expect((await divider.boundingBox())!.x).toBeCloseTo(200, 0);
		await loomPage.mouse.move(x - 106, y, { steps: 5 });
		await expect(shell).toHaveCSS("--library-width", "200px");
		const sidebarBox = (await loomPage.locator("#library-sidebar").boundingBox())!;
		expect(x - 106).toBeGreaterThan(sidebarBox.x);
		expect(x - 106).toBeLessThan(sidebarBox.x + sidebarBox.width);
		expect(await loomPage.evaluate(() => [...document.querySelectorAll("#library-sidebar, #library-sidebar *")].some((element) => element.matches(":hover")))).toBe(false);
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await loomPage.mouse.move(x - 107, y);
		await expect(shell).toHaveCSS("--library-width", "0px");
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(togglePanel).toBeVisible();
		const closing = await foldingLayout();
		expect(closing?.width).toBeGreaterThan(0);
		expect(closing?.width).toBeLessThan(200);
		expect(closing?.viewsLeft).toBe(initialViews.x);
		await expect(divider).toBeHidden();
		expect(await savedCollapse()).toBe("0");
		await expect(loomPage.locator("body")).toHaveClass(/\bresizing-columns\b/);
		await loomPage.mouse.move(x + 15, y, { steps: 5 });
		await expect(shell).toHaveCSS("--library-width", "255px");
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(togglePanel).toHaveCount(0);
		const opening = await foldingLayout();
		expect(opening?.width).toBeGreaterThan(0);
		expect(opening?.width).toBeLessThan(255);
		expect(opening?.viewsLeft).toBe(initialViews.x);
		await expect(divider).toBeVisible();
	} finally {
		await loomPage.mouse.up();
	}

	await expect(shell).toHaveCSS("--library-width", "255px");
	await expect(divider).toBeVisible();
	await expect.poll(async () => (await divider.boundingBox())?.x).toBeCloseTo(255, 0);
	await expect(loomPage.locator("body")).not.toHaveClass(/\bresizing-columns\b/);
	await loomPage.mouse.move(x + 15, y);
	await loomPage.mouse.down();
	try {
		await loomPage.mouse.move(x - 120, y, { steps: 5 });
		await expect(shell).toHaveCSS("--library-width", "0px");
		expect(await savedCollapse()).toBe("0");
	} finally {
		await loomPage.mouse.up();
	}
	await expect(shell).toHaveCSS("--library-width", "0px");
	await expect.poll(savedCollapse).toBe("1");
	await loomPage.getByRole("button", { name: "Expand sidebar", exact: true }).click();
	await expect(shell).toHaveCSS("--library-width", "200px");
	await expect(divider).toBeVisible();
	await expect(shell).toHaveCSS("--library-open-progress", "1");
	await loomPage.emulateMedia({ reducedMotion: "reduce" });
	await loomPage.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
	await expect(shell).toHaveCSS("--library-width", "0px");
	expect(await foldingLayout()).toBeNull();
	await expect(shell).toHaveCSS("--library-open-progress", "0");
});

test("view tabs keep their icons and show only the active label without moving the display controls", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated renderer required");
	for (const width of [200, 240, 320]) {
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

test("tab options share the toolbar tooltip, stay within the viewport, and support keyboard focus", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated renderer required");
	await loomPage.evaluate(() => localStorage.setItem("loom.layout.libraryWidth", "200"));
	await loomPage.reload();
	const controls = loomPage.locator(".library-view-controls");
	const tooltip = loomPage.getByRole("tooltip");
	const tooltipStyle = (element: Element) => {
		const style = getComputedStyle(element);
		return { background: style.backgroundColor, color: style.color, fontSize: style.fontSize, borderRadius: style.borderRadius, padding: style.padding };
	};
	await loomPage.locator(".window-bar, .mac-window-actions").getByRole("button", { name: "Open", exact: true }).hover();
	await expect(tooltip).toBeVisible({ timeout: 500 });
	const expectedStyle = await tooltip.evaluate(tooltipStyle);
	for (const name of ["Table", "Graph", "Library", "List", "Icons"]) {
		const button = controls.getByRole("button", { name, exact: true });
		await expect(button).not.toHaveAttribute("title");
		await button.hover();
		await expect(tooltip).toHaveText(name, { timeout: 500 });
		expect(await tooltip.evaluate(tooltipStyle)).toEqual(expectedStyle);
		await expect(button).toHaveAttribute("aria-describedby", (await tooltip.getAttribute("id"))!);
		const bounds = (await tooltip.boundingBox())!;
		expect(bounds.x).toBeGreaterThanOrEqual(0);
		expect(bounds.x + bounds.width).toBeLessThanOrEqual(await loomPage.evaluate(() => innerWidth));
	}
	await loomPage.mouse.move(600, 20);
	await controls.getByRole("button", { name: "Table", exact: true }).focus();
	await loomPage.keyboard.press("Tab");
	await expect(controls.getByRole("button", { name: "Graph", exact: true })).toBeFocused();
	await expect(tooltip).toHaveText("Graph", { timeout: 500 });
	// Live labels must update the open tooltip without requiring another hover.
	const graph = controls.getByRole("button", { name: "Graph", exact: true });
	await graph.evaluate((element) => element.setAttribute("data-tooltip", "Updated graph hint"));
	await expect(tooltip).toHaveText("Updated graph hint");
	await graph.evaluate((element) => element.removeAttribute("data-tooltip"));
	await expect(tooltip).toHaveText("Graph");
});

test("toolbar, view, sidebar, and panel tooltips leave after 80ms and clicks dismiss them immediately", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated renderer required");
	const tooltip = loomPage.getByRole("tooltip");
	const buttons = [
		loomPage.locator(".window-bar, .mac-window-actions").getByRole("button", { name: "Open", exact: true }),
		loomPage.locator(".library-view-controls").getByRole("button", { name: "Table", exact: true }),
		loomPage.locator(".library-sidebar-actions").getByRole("button", { name: "Settings", exact: true }),
		loomPage.locator(".panel-collapse[aria-label]").first(),
	];
	for (const button of buttons) {
		await button.hover();
		await expect(tooltip).toBeVisible({ timeout: 500 });
		await loomPage.mouse.move(600, 20);
		await expect(tooltip).toHaveCount(0, { timeout: 250 });
		await button.hover();
		await expect(tooltip).toBeVisible({ timeout: 500 });
		await button.evaluate((element) => {
			// Keep the dismissal test from opening dialogs or collapsing panels.
			element.addEventListener("click", (event) => event.stopPropagation(), { once: true });
			(element as HTMLButtonElement).click();
		});
		await expect(tooltip).toHaveCount(0);
		await loomPage.waitForTimeout(200);
		await expect(tooltip).toHaveCount(0);
		await loomPage.mouse.move(600, 20);
		await button.hover();
		await expect(tooltip).toBeVisible({ timeout: 500 });
		await loomPage.keyboard.press("Escape");
		await expect(tooltip).toHaveCount(0);
		await loomPage.mouse.move(600, 20);
	}
});

test("Loom and the sidebar actions stay aligned at the bottom while files scroll", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	await loomPage.evaluate(() => localStorage.setItem("loom.layout.libraryWidth", "200"));
	await loomPage.reload();
	const rootPath = () => loomPage.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(rootPath).toBeTruthy();
	const root = (await rootPath())!;
	const fileCount = 45;
	await Promise.all(Array.from({ length: fileCount }, (_, index) => writeFile(join(root, `file-${index}.md`), "# Document")));
	const sidebar = loomPage.locator(".library-sidebar");
	const actions = sidebar.locator("footer");
	const brand = actions.getByText("Loom", { exact: true });
	const settings = actions.getByRole("button", { name: "Settings", exact: true });
	const traces = actions.getByRole("button", { name: "Traces", exact: true });
	const help = actions.getByRole("button", { name: "Help", exact: true });
	const files = sidebar.locator(".asset-list");
	await expect(files.locator(".asset-row")).toHaveCount(fileCount);
	await expect(brand).toBeVisible();
	for (const name of ["Settings", "Traces", "Help"]) {
		await expect(actions.getByRole("button", { name, exact: true })).toBeVisible();
		await expect(loomPage.locator(".window-bar").getByRole("button", { name, exact: true })).toHaveCount(0);
	}
	const footer = (await actions.boundingBox())!;
	const sidebarBounds = (await sidebar.boundingBox())!;
	expect(footer.y + footer.height).toBeCloseTo(sidebarBounds.y + sidebarBounds.height, 0);
	const brandBounds = (await brand.boundingBox())!;
	const settingsBounds = (await settings.boundingBox())!;
	const helpBounds = (await help.boundingBox())!;
	expect(brandBounds.x + brandBounds.width).toBeLessThan(settingsBounds.x);
	expect(brandBounds.x - footer.x).toBeCloseTo(footer.x + footer.width - helpBounds.x - helpBounds.width, 0);
	const scrollTop = await files.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
		return element.scrollTop;
	});
	expect(scrollTop).toBeGreaterThan(0);
	expect(await actions.boundingBox()).toEqual(footer);

	await loomPage.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
	await expect(actions).toBeHidden();
	await loomPage.getByRole("button", { name: "Expand sidebar", exact: true }).click();
	await settings.focus();
	await loomPage.keyboard.press("Tab");
	await expect(traces).toBeFocused();
	const opened = electronApp!.waitForEvent("window");
	await traces.press("Enter");
	const trace = await opened;
	await expect(trace.getByRole("tab", { name: "Traces", exact: true })).toBeVisible();
	await trace.close();
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
	const title = header.locator(".file-heading-title");
	const files = sidebar.locator(".asset-list");
	await expect(sidebar.locator(".library-header, .workspace-heading")).toHaveCount(0);
	await expect(workspace.getByRole("group", { name: "File display" })).toBeVisible();
	await expect(workspace.locator(".file-sort")).toHaveCount(0);
	await expect(workspace.getByRole("button", { name: "Search files", exact: true })).toHaveCount(0);
	await expect(title).toHaveText(basename(root));
	await expect(header.locator(".library-files-name")).toHaveAttribute("data-tooltip", root);
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
	await expect(title).toHaveText(basename(root));
	await expect(files.locator(".asset-name")).toHaveText(["alpha.md"]);
	await search.press("Escape");
	await expect(search).toHaveCount(0);
	await expect(files.locator(".asset-name")).toHaveText(["beta.md", "alpha.md"]);
	await workspace.getByRole("button", { name: "Icons", exact: true }).click();
	await expect(header.locator(".file-sort")).toHaveCount(0);
	await expect(header.getByRole("button", { name: "Search files", exact: true })).toHaveCount(0);
	await expect(title).toHaveText(basename(root));
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
	const rootIcon = sidebar.locator('.library-files-name > svg[aria-hidden="true"]');
	const geometry = () => sidebar.evaluate((element) => {
		const heading = element.querySelector(".library-files-heading")!.getBoundingClientRect();
		const title = element.querySelector(".library-files-name")!.getBoundingClientRect();
		const icon = element.querySelector(".library-files-name > svg")!.getBoundingClientRect();
		const tree = element.querySelector(".asset-list")!.getBoundingClientRect();
		return { headingY: heading.y, headingHeight: heading.height, titleX: title.x, titleY: title.y, iconX: icon.x, iconY: icon.y, treeY: tree.y };
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
		for (const width of [200, 320]) {
			await loomPage.evaluate((width) => localStorage.setItem("loom.layout.libraryWidth", String(width)), width);
			await loomPage.reload();
			await expect(workspace.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
			await expect(rootIcon).toBeVisible();
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
	await loomPage.evaluate(() => localStorage.setItem("loom.layout.libraryWidth", "200"));
	await loomPage.reload();
	const sidebar = loomPage.locator(".library-sidebar");
	const name = sidebar.locator(".library-files-name");
	const label = name.locator(".library-files-name-label");
	await expect(sidebar.locator(".library-header")).toHaveCount(0);
	await expect(name).toHaveText(folderName);
	await expect(name).toHaveAttribute("data-tooltip", root);
	await expect(name).toHaveCSS("font-size", "12px");
	await expect(name).toHaveCSS("text-transform", "none");
	await expect(label).toHaveCSS("text-overflow", "ellipsis");
	expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
	const bounds = (await name.boundingBox())!;
	const tools = (await sidebar.locator(".library-files-heading .file-heading-tools").boundingBox())!;
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(tools.x);
	await name.hover();
	await expect(loomPage.getByRole("tooltip")).toHaveText(root);
});

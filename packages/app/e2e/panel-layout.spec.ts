import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { expect, test } from "./loom.ts";

type PlaceMode = "dock" | "float" | "bottom" | "beside" | "above";

async function savedPanel(page: Page, id: string) {
	return page.evaluate((id) => {
		const state = JSON.parse(localStorage.getItem("loom.layout.panels")!);
		const slot = state.slots.find((slot: { tabs: string[] }) => slot.tabs.includes(id));
		return { place: slot.place, members: slot.tabs.length > 1 ? slot.tabs.join(",") : "", opened: state.opened.includes(id) };
	}, id);
}

async function resetFirstGradeOpen(page: Page) {
	await page.evaluate(() => {
		const state = JSON.parse(localStorage.getItem("loom.layout.panels")!);
		state.opened = state.opened.filter((id: string) => id !== "grade");
		localStorage.setItem("loom.layout.panels", JSON.stringify(state));
	});
}

for (const grouped of [false, true]) test(`first Edit joins Grade into the right ${grouped ? "saved" : "default"} tab group and remembers a later floating position`, async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await expect(page.locator(".shell")).toBeVisible();
	await page.evaluate((grouped) => {
		for (const key of Object.keys(localStorage)) if (key.startsWith("loom.layout.")) localStorage.removeItem(key);
		if (grouped) localStorage.setItem("loom.layout.members", "agent,details");
	}, grouped);
	await page.reload();
	await expect(page.locator('.work-panel[data-panel="agent"]')).toBeAttached();
	// Reload before the first Edit must not turn the default into a saved independent placement.
	expect((await savedPanel(page, "grade")).opened).toBe(false);
	await page.reload();
	await openGrade(page);
	const gradeTab = page.locator('.panel-tabs button[data-tab="grade"]');
	await expect(gradeTab).toHaveClass(/\bactive\b/);
	await expect(page.locator('.panel-tabs button[data-tab="details"]')).toBeVisible();
	const saved = await savedPanel(page, "grade");
	expect(saved.place).toEqual({ mode: "dock" });
	expect(saved.members).toBe("agent,details,grade");
	await expectDockLayout(page);
	await page.locator(".preview-actions button").first().click();
	await expect(gradeTab).toBeHidden();
	await page.locator('.preview-actions button[aria-label="Edit"]').click();
	await expect(gradeTab).toHaveClass(/\bactive\b/);
	const handle = await gradeTab.boundingBox();
	try {
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(500, 220, { steps: 12 });
		await expect(page.locator('.work-panel[data-panel="grade"]')).toHaveClass(/\bfloat\b/);
		await page.mouse.up();
	} finally { await page.mouse.up(); }
	const floating = (await savedPanel(page, "grade")).place;
	expect(floating.mode).toBe("float");
	await page.reload();
	await openGrade(page);
	await expect(page.locator('.work-panel[data-panel="grade"]')).toHaveClass(/\bfloat\b/);
	expect((await savedPanel(page, "grade")).place).toEqual(floating);
});

for (const detailsMode of ["float", "bottom"] as const) test(`first Edit joins the docked Chat when Details is ${detailsMode}`, async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, ["dock", detailsMode, "dock"]);
	await resetFirstGradeOpen(page);
	await page.reload();
	await openGrade(page);
	await expect(page.locator('.panel-tabs button[data-tab="grade"]')).toHaveClass(/\bactive\b/);
	expect((await savedPanel(page, "grade")).members).toBe("agent,grade");
	expect((await savedPanel(page, "details")).place.mode).toBe(detailsMode);
});

test("first Edit creates a right dock without moving existing floating panels", async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, ["float", "float", "dock"]);
	await resetFirstGradeOpen(page);
	await page.reload();
	await openGrade(page);
	await expect(page.locator('.work-panel[data-panel="grade"]')).toHaveClass(/\bdock\b/);
	for (const id of ["agent", "details"]) await expect(page.locator(`.work-panel[data-panel="${id}"]`)).toHaveClass(/\bfloat\b/);
	await expectDockLayout(page);
});

async function configurePanels(page: Page, modes: readonly PlaceMode[], members: readonly string[] = []): Promise<void> {
	await expect(page.locator(".shell")).toBeVisible();
	await page.evaluate(({ modes, members }) => {
		for (const key of Object.keys(localStorage)) if (key.startsWith("loom.layout.")) localStorage.removeItem(key);
		for (const [index, panel] of ["agent", "details", "grade"].entries()) {
			const mode = modes[index] ?? "float";
			localStorage.setItem(`loom.layout.${panel}Place`, JSON.stringify(mode === "float"
				? { mode, x: 300, y: 60, width: 320, height: 300 }
				: { mode }));
		}
		localStorage.setItem("loom.layout.members", members.join(","));
		localStorage.setItem("loom.layout.tab", members[0] ?? "agent");
	}, { modes, members });
	await page.reload();
	await expect(page.locator('.work-panel[data-panel="agent"]')).toBeAttached();
}

async function openGrade(page: Page): Promise<void> {
	const root = await page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	expect(root).toBeTruthy();
	await writeFile(join(root!, "layout.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY2kAAAAASUVORK5CYII=", "base64"));
	await page.locator(".asset-row").filter({ hasText: "layout.png" }).click();
	await page.locator('.preview-actions button[aria-label="Edit"]').click();
	await expect(page.locator('.work-panel[data-panel="grade"]')).toBeAttached();
}

async function expectDockLayout(page: Page): Promise<void> {
	const geometry = await page.evaluate(() => {
		const box = (element: Element) => {
			const rect = element.getBoundingClientRect();
			return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
		};
		return {
			shell: box(document.querySelector(".shell")!),
			tree: box(document.querySelector(".library-sidebar")!),
			divider: box(document.querySelector(".side-resize")!),
			panels: [...document.querySelectorAll(".work-panel.dock")].filter((panel) => getComputedStyle(panel).display !== "none").map((panel) => ({ id: panel.getAttribute("data-panel"), ...box(panel) })),
		};
	});
	expect(geometry.tree.height, "file tree must not share its column with a panel").toBeCloseTo(geometry.shell.height, 1);
	for (const panel of geometry.panels) {
		expect(panel.left, `${panel.id} stays in the right sidebar`).toBeCloseTo(geometry.divider.right - 5, 1);
		expect(panel.right).toBeCloseTo(geometry.shell.right, 1);
		expect(panel.height).toBeGreaterThan(80);
		expect(panel.bottom).toBeLessThanOrEqual(geometry.shell.bottom + 1);
	}
	const ordered = geometry.panels.sort((a, b) => a.top - b.top);
	for (let index = 1; index < ordered.length; index++) expect(ordered[index].top, "docked panels must not overlap").toBeGreaterThanOrEqual(ordered[index - 1].bottom - 1);
}

for (const sourceMode of ["dock", "float", "bottom", "beside"] as const) test(`tab-merge hover from ${sourceMode} aligns with the right sidebar and landed tabs`, async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await expect(page.locator(".shell")).toBeVisible();
	await page.evaluate((mode) => {
		for (const key of Object.keys(localStorage)) if (key.startsWith("loom.layout.")) localStorage.removeItem(key);
		localStorage.setItem("loom.layout.agentPlace", JSON.stringify(mode === "float"
			? { mode, x: 300, y: 60, width: 320, height: 300 }
			: { mode }));
	}, sourceMode);
	await page.reload();
	const agent = page.locator('.work-panel[data-panel="agent"]');
	const details = page.locator('.work-panel[data-panel="details"]');
	await expect(agent.locator(".work-panel-title")).toBeVisible();
	await expect(details.locator(".work-panel-title")).toBeVisible();
	const initial = await details.boundingBox();
	const handle = await agent.locator(".work-panel-title").boundingBox();
	expect(initial).toBeTruthy(); expect(handle).toBeTruthy();
	try {
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(initial!.x + initial!.width * 0.65, initial!.y + initial!.height * 0.65, { steps: 12 });
		// Let the dragged panel leave its band before sampling the stationary hover target.
		await expect(agent).toHaveClass(/\bfloat\b/);
		const stationary = await details.boundingBox();
		await page.mouse.move(stationary!.x + stationary!.width * 0.65, stationary!.y + stationary!.height / 2);
		await expect(page.locator(".shell.join-target")).toBeVisible();
		const hover = await page.evaluate(() => {
			const shell = document.querySelector(".shell")!;
			const target = document.querySelector('.work-panel[data-panel="details"]')!;
			const title = target.querySelector(".work-panel-title")!;
			const overlay = getComputedStyle(shell, "::before");
			return {
				overlayLeft: shell.getBoundingClientRect().left + Number.parseFloat(overlay.left),
				panelLeft: target.getBoundingClientRect().left,
				titleLeft: title.getBoundingClientRect().left,
				panelWidth: target.getBoundingClientRect().width,
				overlayWidth: Number.parseFloat(overlay.width),
			};
		});
		expect(hover.overlayLeft, "sidebar edge must not shift when its neighbor starts dragging").toBeCloseTo(initial!.x, 1);
		expect(hover.overlayLeft, "outline aligns with target panel").toBeCloseTo(hover.panelLeft, 1);
		expect(hover.overlayLeft, "outline aligns with visible title edge").toBeCloseTo(hover.titleLeft, 1);
		expect(hover.overlayWidth).toBeCloseTo(hover.panelWidth, 1);
		await page.mouse.up();
		await expect(page.locator(".side-stack.joined.dock-band")).toBeVisible();
		const landed = await page.locator(".side-stack.joined.dock-band").boundingBox();
		expect(landed!.x).toBeCloseTo(hover.overlayLeft, 1);
		expect(landed!.width).toBeCloseTo(hover.overlayWidth, 1);
		await expect(page.locator('.panel-tabs button[data-tab="agent"]')).toBeVisible();
		await expect(page.locator('.panel-tabs button[data-tab="details"]')).toBeVisible();
	} finally { await page.mouse.up(); }
});

for (const targetMode of ["bottom", "above", "float"] as const) test(`sidebar drag outlines the ${targetMode} panel from its visible top edge`, async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, ["dock", targetMode, "float"]);
	const agent = page.locator('.work-panel[data-panel="agent"]');
	const details = page.locator('.work-panel[data-panel="details"]');
	const handle = await agent.locator(".work-panel-title").boundingBox();
	const target = await details.boundingBox();
	try {
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(target!.x + target!.width * 0.65, target!.y + target!.height * 0.65, { steps: 12 });
		await expect(agent).toHaveClass(/\bfloat\b/);
		const current = await details.boundingBox();
		await page.mouse.move(current!.x + current!.width * 0.65, current!.y + current!.height * 0.65);
		await expect(page.locator(".shell.join-target")).toBeVisible();
		const geometry = await page.evaluate(() => {
			const shell = document.querySelector(".shell")!;
			const panel = document.querySelector('.work-panel[data-panel="details"]')!;
			const css = getComputedStyle(shell, "::before");
			const bounds = panel.closest("[data-slot]")!.getBoundingClientRect();
			const headingTop = panel.querySelector(".work-panel-title")!.getBoundingClientRect().top;
			const divider = shell.querySelector(".bottom-resize, .above-resize");
			const lineTop = divider ? divider.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(divider, "::after").top) : null;
			return { overlayTop: shell.getBoundingClientRect().top + Number.parseFloat(css.top), border: Number.parseFloat(css.borderTopWidth), panelTop: bounds.top, headingTop, lineTop, overlayHeight: Number.parseFloat(css.height), panelHeight: bounds.height };
		});
		if (targetMode === "float") expect(geometry.overlayTop).toBeCloseTo(geometry.panelTop, 1);
		else {
			expect(geometry.overlayTop + geometry.border, "outline's inner edge touches the blue heading without a white strip").toBeCloseTo(geometry.headingTop, 1);
			expect(geometry.lineTop, "divider line meets the outline's outer edge").toBeCloseTo(geometry.overlayTop, 1);
		}
		expect(geometry.overlayTop + geometry.overlayHeight).toBeCloseTo(geometry.panelTop + geometry.panelHeight, 1);
		await page.mouse.up();
	} finally { await page.mouse.up(); }
});

for (const mode of ["bottom", "above"] as const) test(`sidebar hover over joined ${mode} tabs meets the blue tab bar without a white strip`, async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, ["dock", mode, mode], ["details", "grade"]);
	await openGrade(page);
	const source = await page.locator('.work-panel[data-panel="agent"] > .work-panel-title').boundingBox();
	const target = await page.locator(".side-stack.joined").boundingBox();
	try {
		await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
		await page.mouse.down();
		await page.mouse.move(target!.x + target!.width * 0.65, target!.y + target!.height * 0.65, { steps: 12 });
		await expect(page.locator('.work-panel[data-panel="agent"]')).toHaveClass(/\bfloat\b/);
		// Moving out of the sidebar widens the grade preview; let its layout settle
		// before choosing the center of the target band.
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const current = await page.locator(".side-stack.joined").boundingBox();
		await page.mouse.move(current!.x + current!.width * 0.65, current!.y + current!.height * 0.65);
		await expect(page.locator(".shell.join-target")).toBeVisible();
		const geometry = await page.evaluate(() => {
			const shell = document.querySelector(".shell")!;
			const css = getComputedStyle(shell, "::before");
			const divider = shell.querySelector(".bottom-resize, .above-resize")!;
			return { outline: shell.getBoundingClientRect().top + Number.parseFloat(css.top), border: Number.parseFloat(css.borderTopWidth), heading: document.querySelector(".side-stack.joined > .panel-tabs")!.getBoundingClientRect().top, lineTop: divider.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(divider, "::after").top) };
		});
		expect(geometry.outline + geometry.border, "outline's inner edge touches the tab highlight").toBeCloseTo(geometry.heading, 1);
		expect(geometry.lineTop, "divider line meets the outline's outer edge").toBeCloseTo(geometry.outline, 1);
		await page.mouse.up();
		await expect(page.locator('.panel-tabs button[data-tab="agent"]')).toBeVisible();
	} finally { await page.mouse.up(); }
});

for (const existingAbove of [false, true]) test(`upper splice preview meets the lower divider ${existingAbove ? "with an existing upper panel" : "for a new upper panel"}`, async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, ["dock", "bottom", existingAbove ? "above" : "float"]);
	if (existingAbove) await openGrade(page);
	const agent = page.locator('.work-panel[data-panel="agent"]');
	const details = page.locator('.work-panel[data-panel="details"]');
	const handle = await agent.locator(".work-panel-title").boundingBox();
	const target = await details.boundingBox();
	try {
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(target!.x + target!.width * 0.65, target!.y + 12, { steps: 12 });
		await expect(agent).toHaveClass(/\bfloat\b/);
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const current = await details.boundingBox();
		await page.mouse.move(current!.x + current!.width * 0.65, current!.y + 12);
		await expect(page.locator(".shell.splice-target")).toBeVisible();
		const geometry = await page.evaluate(() => {
			const shell = document.querySelector(".shell")!;
			const css = getComputedStyle(shell, "::before");
			const divider = shell.querySelector(".bottom-resize")!;
			return {
				previewBottom: shell.getBoundingClientRect().top + Number.parseFloat(css.top) + Number.parseFloat(css.height),
				lineTop: divider.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(divider, "::after").top),
			};
		});
		expect(geometry.previewBottom, "upper landing preview touches the lower panel's divider").toBeCloseTo(geometry.lineTop, 1);
		await page.mouse.up();
		await expect(agent).toHaveClass(/\babove\b/);
		await page.mouse.move(400, 100);
		const landed = await agent.evaluate((panel) => {
			const slot = panel.closest('.panel-region[data-region="above"]') ?? panel;
			const divider = document.querySelector(".bottom-resize")!;
			return {
				bottom: slot.getBoundingClientRect().bottom,
				line: divider.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(divider, "::after").top),
			};
		});
		expect(landed.bottom, "upper panel fills the divider area instead of leaving the shell background visible").toBeCloseTo(landed.line, 1);
	} finally { await page.mouse.up(); }
});

for (const grouped of [false, true]) test(`Chat can stack below a lower ${grouped ? "Details tab group" : "Details panel"} and keep the order after reload`, async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, ["dock", "bottom", grouped ? "bottom" : "float"], grouped ? ["details", "grade"] : []);
	if (grouped) await openGrade(page);
	const agent = page.locator('.work-panel[data-panel="agent"]');
	const details = page.locator('.work-panel[data-panel="details"]');
	const upper = page.locator(grouped ? ".side-stack.joined" : '.work-panel[data-panel="details"]');
	const handle = await agent.locator(".work-panel-title").boundingBox();
	try {
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(500, 250, { steps: 10 });
		await expect(agent).toHaveClass(/\bfloat\b/);
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const target = await upper.boundingBox();
		await page.mouse.move(target!.x + target!.width * 0.65, target!.y + target!.height - 12, { steps: 10 });
		await page.mouse.move(target!.x + target!.width * 0.65 + 1, target!.y + target!.height - 12);
		await expect(page.locator(".shell.splice-target")).toBeVisible();
		await expect(page.locator(".shell.join-target")).toHaveCount(0);
		const preview = await page.evaluate(() => {
			const shell = document.querySelector(".shell")!;
			const css = getComputedStyle(shell, "::before");
			const divider = shell.querySelector(".bottom-resize")!;
			return { top: shell.getBoundingClientRect().top + Number.parseFloat(css.top), bottom: shell.getBoundingClientRect().top + Number.parseFloat(css.top) + Number.parseFloat(css.height), line: divider.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(divider, "::after").top), shellBottom: shell.getBoundingClientRect().bottom };
		});
		expect(preview.top, "lower landing preview starts at the divider line").toBeCloseTo(preview.line, 1);
		expect(preview.bottom).toBeCloseTo(preview.shellBottom, 1);
		await page.mouse.up();
		await expect(agent).toHaveClass(/\bbottom\b/);
		await expect(details).toHaveClass(/\babove\b/);
		expect((await upper.boundingBox())!.y).toBeLessThan((await agent.boundingBox())!.y);
		expect((await savedPanel(page, "details")).members).toBe(grouped ? "details,grade" : "");
		await page.reload();
		if (grouped) await openGrade(page);
		await expect(agent).toHaveClass(/\bbottom\b/);
		await expect(details).toHaveClass(/\babove\b/);
		expect((await upper.boundingBox())!.y).toBeLessThan((await agent.boundingBox())!.y);
	} finally { await page.mouse.up(); }
});

test("joined upper tabs cover the lower divider gap and keep it covered after resize", async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, ["above", "bottom", "above"], ["agent", "grade"]);
	await openGrade(page);
	const divider = page.locator(".bottom-resize");
	const assertBoundary = async () => {
		const boundary = await page.evaluate(() => {
			const divider = document.querySelector(".bottom-resize")!;
			const group = document.querySelector('.panel-region[data-region="above"]')!;
			return { bottom: group.getBoundingClientRect().bottom, line: divider.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(divider, "::after").top) };
		});
		expect(boundary.bottom).toBeCloseTo(boundary.line, 1);
	};
	await assertBoundary();
	const handle = await divider.boundingBox();
	try {
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y - 50, { steps: 6 });
		await page.mouse.up();
		await page.mouse.move(400, 100);
		await assertBoundary();
	} finally { await page.mouse.up(); }
});

for (const edge of ["top", "bottom"] as const) test(`dragging onto the right panel ${edge} edge stacks panels instead of joining tabs`, async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, ["float", "dock", "float"]);
	const agent = page.locator('.work-panel[data-panel="agent"]');
	const details = page.locator('.work-panel[data-panel="details"]');
	const handle = await agent.locator(".work-panel-title").boundingBox();
	const target = await details.boundingBox();
	const x = target!.x + target!.width * 0.65;
	const y = edge === "top" ? target!.y + 12 : target!.y + target!.height - 12;
	try {
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(x, y, { steps: 12 });
		await page.mouse.move(x + 1, y);
		await expect(page.locator(".shell.dock-split-target")).toBeVisible();
		await expect(page.locator(".shell.join-target")).toHaveCount(0);
		const preview = await page.evaluate(() => {
			const shell = document.querySelector(".shell")!;
			const style = getComputedStyle(shell, "::before");
			const bounds = shell.getBoundingClientRect();
			return { left: bounds.left + Number.parseFloat(style.left), top: bounds.top + Number.parseFloat(style.top), width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
		});
		expect(preview.left).toBeCloseTo(target!.x, 1);
		expect(preview.width).toBeCloseTo(target!.width, 1);
		expect(preview.height).toBeCloseTo(target!.height / 2, 1);
		expect(preview.top).toBeCloseTo(target!.y + (edge === "top" ? 0 : target!.height / 2), 1);
		await page.mouse.up();
		await expect(agent).toHaveClass(/\bdock\b/);
		await expect(page.locator(".panel-tabs")).toHaveCount(0);
		await expectDockLayout(page);
		const above = edge === "top" ? agent : details;
		const below = edge === "top" ? details : agent;
		expect((await above.boundingBox())!.y).toBeLessThan((await below.boundingBox())!.y);
		const divider = page.locator('.panel-region[data-region="dock"] > .resize-handle.row');
		const resizeHandle = await divider.boundingBox();
		const before = await above.boundingBox();
		await page.mouse.move(resizeHandle!.x + resizeHandle!.width / 2, resizeHandle!.y + resizeHandle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(resizeHandle!.x + resizeHandle!.width / 2, resizeHandle!.y + 65);
		await page.mouse.up();
		const resized = await above.boundingBox();
		expect(resized!.height).toBeGreaterThan(before!.height + 30);
		await page.reload();
		await expectDockLayout(page);
		expect((await above.boundingBox())!.y).toBeLessThan((await below.boundingBox())!.y);
		expect((await above.boundingBox())!.height).toBeCloseTo(resized!.height, 1);
	} finally { await page.mouse.up(); }
});

test("a Grade tab can be detached into a vertical dock slot then merged back through the center", async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, ["dock", "dock", "dock"], ["details", "grade"]);
	await openGrade(page);
	const tab = page.locator('.panel-tabs button[data-tab="grade"]');
	const handle = await tab.boundingBox();
	try {
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(500, 200, { steps: 12 });
		const grade = page.locator('.work-panel[data-panel="grade"]');
		await expect(grade).toHaveClass(/\bfloat\b/);
		const details = page.locator('.work-panel[data-panel="details"]');
		const target = await details.boundingBox();
		await page.mouse.move(target!.x + target!.width * 0.65, target!.y + target!.height - 12, { steps: 12 });
		await page.mouse.move(target!.x + target!.width * 0.65 + 1, target!.y + target!.height - 12);
		await expect(page.locator(".shell.dock-split-target")).toBeVisible();
		await page.mouse.up();
		await expectDockLayout(page);
		await expect(page.locator(".panel-tabs")).toHaveCount(0);
		expect((await grade.boundingBox())!.y).toBeGreaterThan((await details.boundingBox())!.y);
		const detached = await grade.locator(".work-panel-title").boundingBox();
		const center = await details.boundingBox();
		await page.mouse.move(detached!.x + detached!.width / 2, detached!.y + detached!.height / 2);
		await page.mouse.down();
		await page.mouse.move(center!.x + center!.width * 0.65, center!.y + center!.height / 2, { steps: 12 });
		await expect(grade).toHaveClass(/\bfloat\b/);
		const current = await details.boundingBox();
		await page.mouse.move(current!.x + current!.width * 0.65, current!.y + current!.height / 2);
		await expect(page.locator(".shell.join-target")).toBeVisible();
		await page.mouse.up();
		await expect(tab).toBeVisible();
		expect((await savedPanel(page, "details")).members).toBe("details,grade");
	} finally { await page.mouse.up(); }
});

for (const moveGroup of [false, true]) test(`vertical docking preserves the ${moveGroup ? "dragged" : "target"} tab group`, async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, moveGroup ? ["float", "float", "dock"] : ["dock", "dock", "float"], ["agent", "details"]);
	await openGrade(page);
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	const source = page.locator(moveGroup ? ".side-stack.joined > .panel-tabs" : '.work-panel[data-panel="grade"] > .work-panel-title');
	const handle = await source.boundingBox();
	const target = await page.locator(moveGroup ? '.work-panel[data-panel="grade"]' : ".side-stack.joined").boundingBox();
	try {
		await page.mouse.move(moveGroup ? handle!.x + handle!.width - 35 : handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(target!.x + target!.width * 0.65, target!.y + 12, { steps: 12 });
		await page.mouse.move(target!.x + target!.width * 0.65 + 1, target!.y + 12);
		await expect(page.locator(".shell.dock-split-target")).toBeVisible();
		await page.mouse.up();
		await expectDockLayout(page);
		expect((await savedPanel(page, "agent")).members).toBe("agent,details");
		const group = await page.locator(".side-stack.joined").boundingBox();
		const grade = await page.locator('.work-panel[data-panel="grade"]').boundingBox();
		expect(moveGroup ? group!.y : grade!.y).toBeLessThan(moveGroup ? grade!.y : group!.y);
		await page.reload();
		await openGrade(page);
		await expectDockLayout(page);
		const restoredGroup = await page.locator(".side-stack.joined").boundingBox();
		const restoredGrade = await page.locator('.work-panel[data-panel="grade"]').boundingBox();
		expect(moveGroup ? restoredGroup!.y : restoredGrade!.y).toBeLessThan(moveGroup ? restoredGrade!.y : restoredGroup!.y);
	} finally { await page.mouse.up(); }
});

for (const smallDetails of [false, true]) test(`detaching Chat keeps Details visible with ${smallDetails ? "small saved" : "default"} split weights`, async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, ["dock", "dock", "float"], ["agent", "details"]);
	if (smallDetails) {
		await page.evaluate(() => {
			const state = JSON.parse(localStorage.getItem("loom.layout.panels")!);
			state.slots.find((slot: { tabs: string[] }) => slot.tabs.includes("details")).weight = 0.05;
			localStorage.setItem("loom.layout.panels", JSON.stringify(state));
		});
		await page.reload();
	}
	const root = await page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await writeFile(join(root!, "details.txt"), "DETAILS_CONTENT_SURVIVES_CHAT_DETACH");
	await page.locator(".asset-row").filter({ hasText: "details.txt" }).click();
	await page.locator('.panel-tabs button[data-tab="details"]').click();
	const details = page.locator('.work-panel[data-panel="details"]');
	await expect(details.locator("dt").filter({ hasText: /^Asset ID$/ })).toBeVisible();
	const before = await details.locator(".details-content").innerText();
	const tab = await page.locator('.panel-tabs button[data-tab="agent"]').boundingBox();
	try {
		await page.mouse.move(tab!.x + tab!.width / 2, tab!.y + tab!.height / 2);
		await page.mouse.down();
		await page.mouse.move(500, 220, { steps: 12 });
		await expect(page.locator('.work-panel[data-panel="agent"]')).toHaveClass(/\bfloat\b/);
		await page.mouse.up();
		const panelBox = await details.boundingBox();
		const sidebarBox = await page.locator('.panel-region[data-region="dock"]').boundingBox();
		expect(panelBox!.height, "the remaining Details panel must fill the sidebar, not keep a fraction of it").toBeCloseTo(sidebarBox!.height, 1);
		for (const label of ["Modified", "Asset ID", "Tags", "Relations"]) {
			const field = details.getByText(label, { exact: true });
			await expect(field).toBeVisible();
			const box = await field.boundingBox();
			expect(box!.y + box!.height, `${label} is inside the panel, not clipped below it`).toBeLessThanOrEqual(panelBox!.y + panelBox!.height);
		}
		expect(await details.locator(".details-content").innerText()).toBe(before);
	} finally { await page.mouse.up(); }
});

const mixedLayouts: readonly (readonly PlaceMode[])[] = [
	["dock", "dock", "float"],
	["float", "dock", "dock"],
	["dock", "float", "dock"],
	["dock", "dock", "bottom"],
	["bottom", "dock", "dock"],
	["dock", "bottom", "dock"],
	["dock", "dock", "beside"],
	["beside", "dock", "dock"],
	["dock", "beside", "dock"],
	["dock", "dock", "above"],
	["above", "dock", "dock"],
	["dock", "above", "dock"],
];

for (const modes of mixedLayouts) test(`grading keeps ${modes.join("/")} panels out of the file-tree column`, async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, modes);
	await openGrade(page);
	await expectDockLayout(page);
	await page.reload();
	await openGrade(page);
	await expectDockLayout(page);
	await page.locator(".preview-actions button").first().click();
	await expect(page.locator('.work-panel[data-panel="grade"]')).toBeHidden();
	await expectDockLayout(page);
});

for (const members of [["agent", "details"], ["agent", "grade"], ["details", "grade"]]) test(`docked tabs ${members.join("/")} share the right column with the remaining panel`, async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, ["dock", "dock", "dock"], members);
	await openGrade(page);
	await expectDockLayout(page);
	await expect(page.locator(".side-stack.joined")).toBeVisible();
});

test("dragging a docked grading panel out and back keeps the other panels in the sidebar", async ({ loomPage: page }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await configurePanels(page, ["dock", "dock", "dock"]);
	await openGrade(page);
	await expectDockLayout(page);
	const grade = page.locator('.work-panel[data-panel="grade"]');
	const handle = await grade.locator(".work-panel-title").boundingBox();
	const shell = await page.locator(".shell").boundingBox();
	try {
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
		await page.mouse.down();
		await page.mouse.move(500, shell!.y + 180, { steps: 12 });
		await expect(grade).toHaveClass(/\bfloat\b/);
		await page.mouse.up();
		await expectDockLayout(page);
		const floated = await grade.locator(".work-panel-title").boundingBox();
		const details = await page.locator('.work-panel[data-panel="details"]').boundingBox();
		await page.mouse.move(floated!.x + floated!.width / 2, floated!.y + floated!.height / 2);
		await page.mouse.down();
		await page.mouse.move(details!.x + details!.width * 0.65, details!.y + details!.height * 0.65, { steps: 12 });
		await page.mouse.move(details!.x + details!.width * 0.65 + 1, details!.y + details!.height * 0.65);
		await expect(page.locator(".shell.join-target")).toBeVisible();
		await page.mouse.up();
		await expect(page.locator('.panel-tabs button[data-tab="grade"]')).toBeVisible();
		await expectDockLayout(page);
	} finally { await page.mouse.up(); }
});

test("library and side dividers grow past the old caps and still leave the workbench", async ({ loomPage: page, electronApp }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated layout acceptance uses temporary user data");
	await electronApp?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await expect(page.locator(".shell")).toBeVisible();
	const column = (name: string) => page.evaluate((name) => Number.parseFloat(getComputedStyle(document.querySelector(".shell")!).getPropertyValue(name)), name);
	const drag = async (selector: string, dx: number) => {
		const handle = await page.locator(selector).boundingBox();
		expect(handle).toBeTruthy();
		const x = handle!.x + handle!.width / 2;
		const y = handle!.y + handle!.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + dx, y, { steps: 10 });
		await page.mouse.up();
	};
	await drag(".library-resize", 200);
	expect(await column("--library-width")).toBeGreaterThan(360);
	await drag(".side-resize", -200);
	expect(await column("--side-width")).toBeGreaterThan(520);
	const workbench = await page.locator(".workbench").boundingBox();
	expect(workbench!.width).toBeGreaterThanOrEqual(240);
});

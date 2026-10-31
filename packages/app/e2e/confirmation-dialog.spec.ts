import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, saveChatEndpoint, test } from "./loom.ts";

test("danger confirmation traps focus, cancels safely, restores focus and blocks background shortcuts", async ({ loomPage }) => {
	await expect(loomPage.locator(".library-sidebar")).toBeVisible();
	let nativeDialogs = 0;
	loomPage.on("dialog", (dialog) => { nativeDialogs++; void dialog.dismiss(); });
	await loomPage.locator(".library-views").getByRole("button", { name: "Table", exact: true }).click();
	await loomPage.getByRole("button", { name: "+ Add field", exact: true }).click();
	await loomPage.getByPlaceholder("Field name", { exact: true }).fill("Status");
	await loomPage.locator(".table-property-form").getByRole("button", { name: "Add", exact: true }).click();
	await loomPage.getByRole("columnheader", { name: /Status/ }).getByRole("button", { name: "Edit", exact: true }).click();
	const trigger = loomPage.locator(".table-property-form").getByRole("button", { name: "Delete", exact: true });
	const dialog = loomPage.getByRole("dialog", { name: "Delete property “Status”?", exact: true });
	const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
	const approve = dialog.getByRole("button", { name: "Delete property", exact: true });

	await trigger.click();
	await expect(dialog).toHaveAttribute("data-tone", "danger");
	await expect(dialog).toHaveAttribute("aria-describedby");
	await expect(cancel).toBeFocused();
	await loomPage.keyboard.press("Shift+Tab");
	await expect(approve).toBeFocused();
	await loomPage.keyboard.press("Tab");
	await expect(cancel).toBeFocused();
	// A background window listener should never see a shortcut or Delete while modal.
	await loomPage.evaluate(() => {
		const state = window as typeof window & { confirmationKeys: string[] };
		state.confirmationKeys = [];
		window.addEventListener("keydown", (event) => state.confirmationKeys.push(event.key));
	});
	await loomPage.keyboard.press("Control+d");
	await loomPage.keyboard.press("Delete");
	expect(await loomPage.evaluate(() => (window as typeof window & { confirmationKeys: string[] }).confirmationKeys)).toEqual([]);
	await expect(dialog).toBeVisible();
	await loomPage.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	expect((await loomPage.evaluate(() => window.loom.getPropertySnapshot())).properties).toHaveLength(1);

	// Enter on the initial Cancel is safe; Enter on the explicitly focused action approves.
	await trigger.click();
	await loomPage.keyboard.press("Enter");
	await expect(dialog).toHaveCount(0);
	// Programmatic navigation simulates the caller going away while a question is open.
	await trigger.click();
	await loomPage.locator(".library-views").getByRole("button", { name: "Graph", exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
	await expect(dialog).toHaveCount(0);
	expect((await loomPage.evaluate(() => window.loom.getPropertySnapshot())).properties).toHaveLength(1);
	await loomPage.locator(".library-views").getByRole("button", { name: "Table", exact: true }).click();
	await loomPage.getByRole("columnheader", { name: /Status/ }).getByRole("button", { name: "Edit", exact: true }).click();
	await trigger.click();
	await loomPage.keyboard.press("Tab");
	await expect(approve).toBeFocused();
	await loomPage.keyboard.press("Enter");
	await expect(dialog).toHaveCount(0);
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getPropertySnapshot())).properties.length).toBe(0);
	expect(nativeDialogs).toBe(0);
});

for (const language of ["en", "zh-CN"] as const) {
	test(`confirmation copy stays aligned and long ${language} titles fit a narrow window`, async ({ loomPage }) => {
		await expect(loomPage.locator(".library-sidebar")).toBeVisible();
		if (language === "zh-CN") {
			await loomPage.evaluate(() => window.loom.saveGeneralSettings({ language: "zh-CN" }));
			await loomPage.reload();
			await expect(loomPage.locator("html")).toHaveAttribute("lang", "zh-CN");
		}
		const chinese = language === "zh-CN";
		const name = chinese ? "项目状态与下一阶段的交付安排及验收结果" : "Project status and next milestone delivery and review results";
		await loomPage.locator(".library-views").getByRole("button", { name: chinese ? "表格" : "Table", exact: true }).click();
		await loomPage.getByRole("button", { name: chinese ? "+ 添加字段" : "+ Add field", exact: true }).click();
		await loomPage.locator(".table-property-form input").fill(name);
		await loomPage.locator(".table-property-form").getByRole("button", { name: chinese ? "添加" : "Add", exact: true }).click();
		await loomPage.getByRole("columnheader").filter({ hasText: name }).getByRole("button", { name: chinese ? "编辑" : "Edit", exact: true }).click();
		await loomPage.locator(".table-property-form").getByRole("button", { name: chinese ? "删除" : "Delete", exact: true }).click();
		const dialog = loomPage.locator(".confirmation-dialog");
		await expect(dialog).toBeVisible();
		for (const viewport of [{ width: 1200, height: 800 }, { width: 320, height: 320 }]) {
			await loomPage.setViewportSize(viewport);
			const layout = await dialog.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				const heading = element.querySelector("h2")!.getBoundingClientRect();
				const description = element.querySelector(".confirmation-description")!.getBoundingClientRect();
				return {
					left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
					headingLeft: heading.left, descriptionLeft: description.left,
					overflows: element.scrollWidth > element.clientWidth,
				};
			});
			expect(layout.headingLeft).toBeCloseTo(layout.descriptionLeft);
			expect(layout.overflows).toBe(false);
			expect(layout.left).toBeGreaterThanOrEqual(0);
			expect(layout.right).toBeLessThanOrEqual(viewport.width);
			expect(layout.top).toBeGreaterThanOrEqual(0);
			expect(layout.bottom).toBeLessThanOrEqual(viewport.height);
			for (const button of await dialog.getByRole("button").all()) await expect(button).toBeInViewport();
		}
		await loomPage.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
	});
}

test("full permission uses the warning dialog and changes only after approval", async ({ loomPage }) => {
	await expect(loomPage.locator(".library-sidebar")).toBeVisible();
	const trigger = loomPage.getByRole("button", { name: "Agent permission", exact: true });
	const dialog = loomPage.getByRole("dialog", { name: "Enable full permission?", exact: true });
	for (const approved of [false, true]) {
		await trigger.click();
		await loomPage.getByRole("option", { name: "Full permission", exact: true }).click();
		await expect(dialog).toHaveAttribute("data-tone", "warning");
		await expect(dialog).toContainText("turns off the process sandbox");
		if (approved) await dialog.getByRole("button", { name: "Enable full permission", exact: true }).click();
		else await loomPage.mouse.click(5, 100);
		await expect(dialog).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await expect.poll(() => loomPage.evaluate(() => window.loom.getAgentPermission())).toBe(approved ? "full" : "standard");
	}
});

for (const kind of ["file", "folder", "batch"] as const) {
	test(`trashing a ${kind} confirms in Loom before calling the main-process operation`, async ({ loomPage, electronApp }) => {
		test.skip(!electronApp, "isolated library required");
		await expect(loomPage.locator(".library-sidebar")).toBeVisible();
		const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
		await writeFile(join(root, "first.md"), "first");
		await writeFile(join(root, "second.md"), "second");
		await mkdir(join(root, "bundle"));
		await writeFile(join(root, "bundle", "nested.md"), "nested");
		await electronApp!.evaluate(({ shell, dialog }) => {
			const state = globalThis as typeof globalThis & { confirmationTrash: string[] };
			state.confirmationTrash = [];
			shell.trashItem = async (path) => { state.confirmationTrash.push(path); };
			dialog.showMessageBox = (async () => { throw new Error("Unexpected native confirmation"); }) as typeof dialog.showMessageBox;
		});
		const sidebar = loomPage.locator(".library-sidebar");
		await expect(sidebar.locator(".asset-row").filter({ hasText: "first.md" })).toBeVisible({ timeout: 15_000 });
		if (kind === "folder") await sidebar.locator(".folder-main").filter({ hasText: /^bundle$/ }).click();
		else {
			await sidebar.locator(".asset-row").filter({ hasText: "first.md" }).click();
			if (kind === "batch") await sidebar.locator(".asset-row").filter({ hasText: "second.md" }).click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
		}
		const trashKey = process.platform === "darwin" ? "Meta+Backspace" : "Delete";
		await loomPage.keyboard.press(trashKey);
		const dialog = loomPage.locator(".confirmation-dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog).toHaveAttribute("data-tone", "warning");
		await expect(dialog).toContainText(kind === "folder" ? "bundle" : kind === "batch" ? "2 items" : "first.md");
		await expect(dialog).toContainText("recovered");
		expect(await electronApp!.evaluate(() => (globalThis as typeof globalThis & { confirmationTrash: string[] }).confirmationTrash)).toEqual([]);
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await loomPage.keyboard.press(trashKey);
		await expect(dialog).toBeVisible();
		await dialog.locator(".confirmation-primary").click();
		await expect(dialog).toHaveCount(0);
		await expect.poll(() => electronApp!.evaluate(() => (globalThis as typeof globalThis & { confirmationTrash: string[] }).confirmationTrash.length)).toBe(kind === "batch" ? 2 : 1);
	});
}

test("session deletion uses the danger dialog and cancellation keeps the archived conversation", async ({ loomPage }) => {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "delete", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
		response.end(chunk({ content: "DELETE_SESSION_REPLY" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		await loomPage.getByRole("textbox").fill("DELETE_SESSION_QUESTION");
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.getByText("DELETE_SESSION_REPLY", { exact: true })).toBeVisible();
		const session = (await loomPage.evaluate(() => window.loom.listSessions())).find((item) => item.title === "DELETE_SESSION_QUESTION")!;
		await loomPage.locator(".session-tab").filter({ hasText: "DELETE_SESSION_QUESTION" }).locator(".session-tab-close").click();
		await loomPage.getByRole("button", { name: "History", exact: true }).click();
		const trigger = loomPage.getByRole("button", { name: "Delete DELETE_SESSION_QUESTION", exact: true });
		await trigger.click();
		const dialog = loomPage.getByRole("dialog", { name: "Delete session?", exact: true });
		await expect(dialog).toHaveAttribute("data-tone", "danger");
		await expect(dialog).toContainText("“DELETE_SESSION_QUESTION” and its messages will be permanently deleted");
		await loomPage.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		expect((await loomPage.evaluate(() => window.loom.listSessions())).some((item) => item.id === session.id)).toBe(true);
		await trigger.click();
		await dialog.getByRole("button", { name: "Delete session", exact: true }).click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).some((item) => item.id === session.id)).toBe(false);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("sign-out confirmation sits above Settings and Escape closes only the confirmation", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated settings required");
	await expect(loomPage.locator(".library-sidebar")).toBeVisible();
	const view = await loomPage.evaluate(() => window.loom.getChatSettings());
	await electronApp!.evaluate(({ ipcMain }, view) => {
		const state = globalThis as typeof globalThis & { confirmationLogouts: number };
		state.confirmationLogouts = 0;
		ipcMain.removeHandler("loom:getChatSettings");
		ipcMain.handle("loom:getChatSettings", () => ({ ...view, config: { ...view.config, providers: [{ kind: "builtin", id: "fixture", enabled: true }] }, models: [], auth: [{ providerId: "fixture", configured: true, type: "oauth" }] }));
		ipcMain.removeHandler("loom:chatProviderCatalog");
		ipcMain.handle("loom:chatProviderCatalog", () => [{ id: "fixture", name: "Fixture Provider", apiKeyAuth: false, oauthAuth: true }]);
		ipcMain.removeHandler("loom:chatLogout");
		ipcMain.handle("loom:chatLogout", () => { state.confirmationLogouts++; });
	}, view);
	await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = loomPage.getByRole("dialog", { name: "Settings", exact: true });
	const trigger = settings.getByRole("button", { name: "Sign out", exact: true });
	await trigger.click();
	const dialog = loomPage.getByRole("dialog", { name: "Sign out of Fixture Provider?", exact: true });
	await expect(dialog).toBeVisible();
	await loomPage.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(settings).toBeVisible();
	await expect(trigger).toBeFocused();
	expect(await electronApp!.evaluate(() => (globalThis as typeof globalThis & { confirmationLogouts: number }).confirmationLogouts)).toBe(0);
	await trigger.click();
	await dialog.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect.poll(() => electronApp!.evaluate(() => (globalThis as typeof globalThis & { confirmationLogouts: number }).confirmationLogouts)).toBe(1);
	await expect(settings).toBeVisible();
});

for (const media of [false, true]) {
	test(`existing ${media ? "description choices" : "reindex confirmation"} use the shared dialog`, async ({ loomPage, electronApp }) => {
		test.skip(!electronApp, "isolated enrichment required");
		await expect(loomPage.locator(".library-sidebar")).toBeVisible();
		const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
		const name = media ? "fixture.png" : "fixture.md";
		if (media) await copyFile(new URL("../../core/tests/fixtures/media/still.png", import.meta.url), join(root, name));
		else await writeFile(join(root, name), "Fixture");
		await electronApp!.evaluate(({ ipcMain }, media) => {
			const state = globalThis as typeof globalThis & { confirmationEnrichment: string[] };
			state.confirmationEnrichment = [];
			const text = (assetId: string) => ({ assetId, supported: true, status: "ready", stale: false, childCount: 1, parentCount: 1 });
			const image = (assetId: string) => ({ assetId, supported: media, status: "ready", stale: false, markdown: "Fixture description" });
			for (const key of ["getTextEmbedStatus", "getImageVlmStatus", "embedAsset", "describeImage"]) ipcMain.removeHandler(`loom:${key}`);
			ipcMain.handle("loom:getTextEmbedStatus", (_event, id: string) => text(id));
			ipcMain.handle("loom:getImageVlmStatus", (_event, id: string) => image(id));
			ipcMain.handle("loom:embedAsset", (_event, id: string) => { state.confirmationEnrichment.push("index"); return text(id); });
			ipcMain.handle("loom:describeImage", (_event, id: string) => { state.confirmationEnrichment.push("describe"); return image(id); });
		}, media);
		await loomPage.locator(".library-sidebar .asset-row").filter({ hasText: name }).click();
		await loomPage.getByRole("button", { name: "Details", exact: true }).click();
		const trigger = loomPage.locator(".details-content").getByRole("button", { name: media ? "Describe" : "Embed", exact: true });
		await trigger.click();
		const dialog = loomPage.getByRole("dialog", { name: media ? "Already described" : "Already indexed", exact: true });
		await expect(dialog.getByRole("button")).toHaveCount(media ? 3 : 2);
		await loomPage.keyboard.press("Escape");
		expect(await electronApp!.evaluate(() => (globalThis as typeof globalThis & { confirmationEnrichment: string[] }).confirmationEnrichment)).toEqual([]);
		await trigger.click();
		await dialog.getByRole("button", { name: media ? "Index only" : "Re-embed", exact: true }).click();
		await expect.poll(() => electronApp!.evaluate(() => (globalThis as typeof globalThis & { confirmationEnrichment: string[] }).confirmationEnrichment)).toEqual(["index"]);
		if (media) {
			await trigger.click();
			await dialog.getByRole("button", { name: "Re-describe and index", exact: true }).click();
			await expect.poll(() => electronApp!.evaluate(() => (globalThis as typeof globalThis & { confirmationEnrichment: string[] }).confirmationEnrichment)).toEqual(["index", "describe"]);
		}
	});
}

test("Chinese Windows confirmations use localized Recycle Bin copy", async ({ loomPage }) => {
	await expect(loomPage.locator(".library-sidebar")).toBeVisible();
	await loomPage.evaluate(() => window.loom.saveGeneralSettings({ language: "zh-CN" }));
	await loomPage.reload();
	await expect(loomPage.locator("html")).toHaveAttribute("lang", "zh-CN");
	await loomPage.evaluate(() => {
		Object.defineProperty(navigator, "userAgent", { value: "Windows NT", configurable: true });
	});
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await writeFile(join(root, "素材.md"), "素材");
	const asset = loomPage.locator(".library-sidebar .asset-row").filter({ hasText: "素材.md" });
	await expect(asset).toBeVisible({ timeout: 15_000 });
	await asset.click();
	await loomPage.keyboard.press("Delete");
	const dialog = loomPage.getByRole("dialog", { name: "要将“素材.md”移到回收站吗？", exact: true });
	await expect(dialog).toContainText("可以从回收站恢复这个文件。");
	await expect(dialog.getByRole("button", { name: "移到回收站", exact: true })).toBeVisible();
	await loomPage.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
});

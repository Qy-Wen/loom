import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("Markdown source edits save by themselves, follow outside changes and ask before overwriting", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-edit-e2e-"));
	const file = join(root, "笔记.md");
	await writeFile(file, "# 标题\n\n* 原文\n");
	try {
		await electronApp!.evaluate(({ dialog }, path) => {
			const original = dialog.showOpenDialog;
			dialog.showOpenDialog = (async () => {
				dialog.showOpenDialog = original;
				return { canceled: false, filePaths: [path] };
			}) as typeof dialog.showOpenDialog;
		}, root);
		await loomPage.evaluate(() => window.loom.openLibrary());
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath).toBe(root);

		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "笔记.md" }).first().click();
		await loomPage.getByRole("tab", { name: "Source" }).click();
		// CodeMirror keeps one `.cm-line` per line; read the document back by joining them.
		const box = loomPage.getByRole("textbox", { name: "Edit 笔记.md" });
		const editorText = () => box.evaluate((node) => [...node.querySelectorAll(".cm-line")].map((line) => line.textContent ?? "").join("\n"));
		await expect.poll(editorText).toBe("# 标题\n\n* 原文\n");
		const status = loomPage.locator(".markdown-editor-status");

		// Opening and leaving without typing writes nothing.
		expect(await readFile(file, "utf8")).toBe("# 标题\n\n* 原文\n");

		// Typing saves after a pause, and the untouched text stays as it was.
		await box.click();
		await box.press("ControlOrMeta+End");
		await box.pressSequentially("新增一行\n");
		await expect(status).toContainText("Unsaved changes");
		await expect.poll(() => readFile(file, "utf8"), { timeout: 10_000 }).toBe("# 标题\n\n* 原文\n新增一行\n");
		await expect(status).toContainText("Saved");

		// The preview shows what was saved.
		await loomPage.getByRole("tab", { name: "Preview" }).click();
		await expect(loomPage.locator(".markdown-preview-body")).toContainText("新增一行");
		await loomPage.getByRole("tab", { name: "Source" }).click();

		// A change from outside with nothing unsaved is taken in.
		await writeFile(file, "# 标题\n\n外部修改\n");
		await expect.poll(editorText, { timeout: 15_000 }).toBe("# 标题\n\n外部修改\n");

		// A change from outside while there is unsaved text is not applied, and saving asks.
		await box.click();
		await box.press("ControlOrMeta+End");
		await box.pressSequentially("我的修改");
		await writeFile(file, "# 标题\n\n第二次外部修改\n");
		await expect(status.getByRole("button", { name: "Overwrite" })).toBeVisible({ timeout: 15_000 });
		await expect.poll(editorText).toBe("# 标题\n\n外部修改\n我的修改");
		expect(await readFile(file, "utf8")).toBe("# 标题\n\n第二次外部修改\n");

		await status.getByRole("button", { name: "Reload" }).click();
		await expect.poll(editorText).toBe("# 标题\n\n第二次外部修改\n");
		await expect(status.getByRole("button", { name: "Overwrite" })).toHaveCount(0);

		// Overwrite writes the editor's text.
		await box.click();
		await box.press("ControlOrMeta+End");
		await box.pressSequentially("甲");
		await writeFile(file, "# 标题\n\n第三次外部修改\n");
		await expect(status.getByRole("button", { name: "Overwrite" })).toBeVisible({ timeout: 15_000 });
		await status.getByRole("button", { name: "Overwrite" }).click();
		await expect.poll(() => readFile(file, "utf8")).toBe("# 标题\n\n第二次外部修改\n甲");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the Markdown editor undoes, finds, keeps composition intact and saves with the shortcut", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-cm-e2e-"));
	const file = join(root, "a.md");
	await writeFile(file, "alpha beta\nbeta gamma\n");
	try {
		await electronApp!.evaluate(({ dialog }, path) => {
			const original = dialog.showOpenDialog;
			dialog.showOpenDialog = (async () => {
				dialog.showOpenDialog = original;
				return { canceled: false, filePaths: [path] };
			}) as typeof dialog.showOpenDialog;
		}, root);
		await loomPage.evaluate(() => window.loom.openLibrary());
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath).toBe(root);
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "a.md" }).first().click();
		await loomPage.getByRole("tab", { name: "Source" }).click();
		const box = loomPage.getByRole("textbox", { name: "Edit a.md" });
		const editorText = () => box.evaluate((node) => [...node.querySelectorAll(".cm-line")].map((line) => line.textContent ?? "").join("\n"));
		await expect.poll(editorText).toBe("alpha beta\nbeta gamma\n");

		// Undo reverts typing, and saving again after it leaves the file as it was.
		await box.click();
		await box.press("ControlOrMeta+Home");
		await box.pressSequentially("X");
		await box.press("ControlOrMeta+s");
		await expect.poll(() => readFile(file, "utf8")).toBe("Xalpha beta\nbeta gamma\n");
		await box.press("ControlOrMeta+z");
		await expect.poll(editorText).toBe("alpha beta\nbeta gamma\n");
		await box.press("ControlOrMeta+s");
		await expect.poll(() => readFile(file, "utf8")).toBe("alpha beta\nbeta gamma\n");

		// Find is the editor's own panel and counts every match.
		await box.press("ControlOrMeta+f");
		const find = loomPage.locator(".cm-search");
		await expect(find).toBeVisible();
		await find.locator("input[name=search]").pressSequentially("beta");
		await expect(loomPage.locator(".cm-searchMatch")).toHaveCount(2);
		await loomPage.keyboard.press("Escape");
		await expect(find).toHaveCount(0);

		// Text typed through an input method is not saved half-composed, and arrives whole.
		await box.click();
		await box.press("ControlOrMeta+End");
		const client = await loomPage.context().newCDPSession(loomPage);
		await client.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
		await client.send("Input.imeSetComposition", { text: "你", selectionStart: 1, selectionEnd: 1 });
		await client.send("Input.insertText", { text: "你" });
		await expect.poll(editorText).toBe("alpha beta\nbeta gamma\n你");
		await expect.poll(() => readFile(file, "utf8"), { timeout: 10_000 }).toBe("alpha beta\nbeta gamma\n你");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("live rendering hides Markdown symbols away from the cursor and never changes the file", async ({ loomPage, electronApp }, testInfo) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-live-e2e-"));
	const file = join(root, "live.md");
	const original = "# 大标题\n\n正文有 **粗体**、*斜体*、`代码` 和 [链接](https://example.com)。\n\n## 二级\n\n末行\n";
	await writeFile(file, original);
	try {
		await electronApp!.evaluate(({ dialog }, path) => {
			const open = dialog.showOpenDialog;
			dialog.showOpenDialog = (async () => {
				dialog.showOpenDialog = open;
				return { canceled: false, filePaths: [path] };
			}) as typeof dialog.showOpenDialog;
		}, root);
		await loomPage.evaluate(() => window.loom.openLibrary());
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath).toBe(root);
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "live.md" }).first().click();
		await loomPage.getByRole("tab", { name: "Source" }).click();
		const box = loomPage.getByRole("textbox", { name: "Edit live.md" });
		await expect(box).toBeVisible();

		// The cursor goes to the last line, away from everything else. What is visible is the rendered text.
		await box.click();
		await box.press("ControlOrMeta+End");
		const shown = () => box.evaluate((node) => [...node.querySelectorAll(".cm-line")].map((line) => {
			const copy = line.cloneNode(true) as HTMLElement;
			copy.querySelectorAll(".cm-live-hidden").forEach((hiddenNode) => hiddenNode.remove());
			return copy.textContent ?? "";
		}).join("\n"));
		await expect.poll(shown).toBe("大标题\n\n正文有 粗体、斜体、代码 和 链接。\n\n二级\n\n末行\n");
		await expect(box.locator(".cm-live-strong")).toHaveText("粗体");
		await expect(box.locator(".cm-live-h1")).toHaveCSS("font-size", /^2[0-9.]+px$/);
		await testInfo.attach("away", { body: await loomPage.screenshot(), contentType: "image/png" });

		// Moving into the bold text brings its symbols back.
		await box.locator(".cm-live-strong").click();
		await expect.poll(shown).toContain("**粗体**");
		await expect.poll(shown).toContain("大标题");
		await testInfo.attach("inside", { body: await loomPage.screenshot(), contentType: "image/png" });

		// Looking, moving and clicking changed nothing on disk.
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(await readFile(file, "utf8")).toBe(original);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

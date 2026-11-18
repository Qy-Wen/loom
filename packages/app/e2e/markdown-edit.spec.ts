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
		const box = loomPage.getByRole("textbox", { name: "Edit 笔记.md" });
		await expect(box).toHaveValue("# 标题\n\n* 原文\n");
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
		await expect(box).toHaveValue("# 标题\n\n外部修改\n", { timeout: 15_000 });

		// A change from outside while there is unsaved text is not applied, and saving asks.
		await box.click();
		await box.press("ControlOrMeta+End");
		await box.pressSequentially("我的修改");
		await writeFile(file, "# 标题\n\n第二次外部修改\n");
		await expect(status.getByRole("button", { name: "Overwrite" })).toBeVisible({ timeout: 15_000 });
		await expect(box).toHaveValue("# 标题\n\n外部修改\n我的修改");
		expect(await readFile(file, "utf8")).toBe("# 标题\n\n第二次外部修改\n");

		await status.getByRole("button", { name: "Reload" }).click();
		await expect(box).toHaveValue("# 标题\n\n第二次外部修改\n");
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

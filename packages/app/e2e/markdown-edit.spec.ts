import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("Markdown source edits save by themselves, follow outside changes and ask before overwriting", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-edit-e2e-"));
	const file = join(root, "笔记.md");
	await writeFile(file, "# 标题\n\n原文\n");
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
		await expect.poll(editorText).toBe("# 标题\n\n原文\n");
		const status = loomPage.locator(".markdown-editor-status");

		// Opening and leaving without typing writes nothing.
		expect(await readFile(file, "utf8")).toBe("# 标题\n\n原文\n");

		// Typing saves after a pause, and the untouched text stays as it was.
		await box.click();
		await box.press("ControlOrMeta+End");
		await box.pressSequentially("新增一行\n");
		await expect(status).toContainText("Unsaved changes");
		await expect.poll(() => readFile(file, "utf8"), { timeout: 10_000 }).toBe("# 标题\n\n原文\n新增一行\n");
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

test("wiki links and pictures render live, flag missing targets and open with a modifier click", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-wiki-e2e-"));
	const source = join(root, "脚本.md");
	const text = [
		"见 [[产品/说明]]、[[产品/说明#结尾|别名]] 和 [[待调研]]。",
		"",
		"![[图/封面.png]]",
		"",
		"![](图/封面.png) ![[没有.png]]",
		"",
		"末行",
		"",
	].join("\n");
	await mkdir(join(root, "产品"));
	await mkdir(join(root, "图"));
	await copyFile(new URL("../../core/tests/fixtures/media/still.png", import.meta.url), join(root, "图", "封面.png"));
	await writeFile(source, text);
	await writeFile(join(root, "产品", "说明.md"), ["# 说明正文", "", ...Array.from({ length: 80 }, (_, index) => `填充 ${index}\n`), "## 结尾"].join("\n"));
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
		const tree = loomPage.locator(".library-sidebar, aside").first();
		await tree.locator(".asset-row").filter({ hasText: "脚本.md" }).first().click();
		await loomPage.getByRole("tab", { name: "Source" }).click();
		const box = loomPage.getByRole("textbox", { name: "Edit 脚本.md" });
		await box.click();
		await box.press("ControlOrMeta+End");

		await expect(box.locator("a, .cm-live-wiki")).toHaveCount(3);
		await expect(box.locator(".cm-live-wiki.cm-live-broken")).toHaveText("待调研");
		// Both ways of writing a picture show it, and the missing one is flagged instead.
		await expect(box.locator("img.cm-live-image")).toHaveCount(2);
		await expect.poll(() => box.locator("img.cm-live-image").first().evaluate((image: HTMLImageElement) => image.naturalWidth > 0)).toBe(true);
		await expect(box.locator(".cm-live-broken")).toHaveCount(2);
		await expect.poll(() => box.locator("img.cm-live-image").first().evaluate((image) => image.getBoundingClientRect().height)).toBeLessThanOrEqual(360);

		// A plain click only edits: the brackets come back and nothing opens.
		await box.locator(".cm-live-wiki").first().click();
		await expect(box).toContainText("[[产品/说明]]");
		await expect(loomPage.getByRole("tab", { name: "脚本.md" })).toBeVisible();
		await box.press("ControlOrMeta+End");

		// A modifier click opens the file at the heading the link names.
		await box.locator(".cm-live-wiki", { hasText: "别名" }).click({ modifiers: ["ControlOrMeta"] });
		await expect(loomPage.locator(".markdown-preview-body").getByRole("heading", { name: "结尾" })).toBeInViewport({ timeout: 10_000 });

		// Looking and clicking left the file as it was.
		expect(await readFile(source, "utf8")).toBe(text);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("lists, task boxes, quotes and rules render live and a task box click edits the text", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-blocks-e2e-"));
	const file = join(root, "块.md");
	const original = "- 苹果\n  - 红的\n- [ ] 买菜\n- [x] 做饭\n\n1. 第一\n2. 第二\n\n> 引用一\n> > 嵌套\n\n---\n\n末行\n";
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "块.md" }).first().click();
		await loomPage.getByRole("tab", { name: "Source" }).click();
		const box = loomPage.getByRole("textbox", { name: "Edit 块.md" });
		await box.click();
		await box.press("ControlOrMeta+End");

		await expect(box.locator(".cm-live-bullet")).toHaveCount(2);
		await expect(box.locator(".cm-live-checkbox")).toHaveCount(2);
		await expect(box.locator(".cm-live-checkbox-checked")).toHaveCount(1);
		await expect(box.locator(".cm-live-rule")).toHaveCount(1);
		await expect(box.locator(".cm-live-quote")).toHaveCount(2);
		await expect(box).toContainText("1. 第一");

		// Ticking a box rewrites one character and saves like any other edit.
		await box.locator(".cm-live-checkbox").first().click();
		await expect(box.locator(".cm-live-checkbox-checked")).toHaveCount(2);
		await expect.poll(() => readFile(file, "utf8")).toBe(original.replace("- [ ] 买菜", "- [x] 买菜"));
		await box.locator(".cm-live-checkbox").nth(1).click();
		await expect.poll(() => readFile(file, "utf8")).toBe(original.replace("- [ ] 买菜", "- [x] 买菜").replace("- [x] 做饭", "- [ ] 做饭"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("code blocks, formulas and diagrams render live and give the source back under the cursor", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-rich-e2e-"));
	const file = join(root, "富.md");
	const original = [
		"# 富内容", "", "能量 $E=mc^2$ 守恒。", "", "$$", "a^2 + b^2 = c^2", "$$", "", "```ts", "const answer = 42;", "```", "",
		"```mermaid", "graph TD; A-->B", "```", "",
		"```mermaid", "flowchart LR", "  A[输入 Markdown] --> B{是不是围栏} --> C[画成代码块或图表] --> D[按普通段落排版]", "```", "", "末行", "",
	].join("\n");
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "富.md" }).first().click();
		await loomPage.getByRole("tab", { name: "Source" }).click();
		const box = loomPage.getByRole("textbox", { name: "Edit 富.md" });
		await box.click();
		await box.press("ControlOrMeta+End");

		await expect(box.locator(".cm-live-math:not(.cm-live-math-block) .katex")).toHaveCount(1);
		await expect(box.locator(".cm-live-math-block .katex-display")).toHaveCount(1);
		await expect(box.locator(".cm-live-codeblock")).toHaveCount(3);
		await expect(box.locator(".cm-live-mermaid svg")).toHaveCount(2, { timeout: 20_000 });
		// A wide diagram scales to the page, as it does in the preview: not collapsed to a fraction of it.
		await expect.poll(async () => {
			const widths = await box.locator(".cm-live-mermaid svg").evaluateAll((all) => all.map((svg) => svg.getBoundingClientRect().width));
			const page = (await box.locator(".cm-live-mermaid").last().boundingBox())!.width;
			return widths[1] / page;
		}).toBeGreaterThan(0.9);
		// Once the diagram is drawn, the cursor at the end of the file sits on the last line, not where the
		// placeholder used to end.
		await expect.poll(async () => {
			const cursor = await loomPage.locator(".cm-cursor").first().boundingBox();
			const line = await box.locator(".cm-line").last().boundingBox();
			return cursor && line ? Math.abs(cursor.y + cursor.height / 2 - (line.y + line.height / 2)) : 999;
		}).toBeLessThan(10);

		// A click on the diagram brings its text back, and a click on a formula does the same.
		await box.locator(".cm-live-mermaid").first().click();
		await expect(box.locator(".cm-live-mermaid")).toHaveCount(1);
		await expect(box).toContainText("graph TD; A-->B");
		await box.press("ControlOrMeta+End");
		await expect(box.locator(".cm-live-mermaid svg")).toHaveCount(2, { timeout: 20_000 });
		await box.locator(".cm-live-math-block").click();
		await expect(box).toContainText("a^2 + b^2 = c^2");

		expect(await readFile(file, "utf8")).toBe(original);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("tables render as tables, edit in their cells and write back only the cell that changed", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-table-e2e-"));
	const file = join(root, "表.md");
	const table = ["| 名称 | 数量 |", "| :--- | ---: |", "| **苹果** | 3 |", "| 梨   | 12 |"].join("\n");
	const original = ["# 表", "", table, "", "结尾", ""].join("\n");
	await writeFile(file, original);
	await writeFile(join(root, "目标.md"), "# 目标\n");
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "表.md" }).first().click();
		await loomPage.getByRole("tab", { name: "Source" }).click();
		const box = loomPage.getByRole("textbox", { name: "Edit 表.md" });
		const onDisk = () => readFile(file, "utf8");

		// Away from the cursor the table is a table: a header row, a body, and the cell's Markdown rendered.
		await expect(box.locator(".cm-live-table th")).toHaveCount(2);
		await expect(box.locator(".cm-live-table td")).toHaveCount(4);
		await expect(box.locator(".cm-live-table td strong")).toHaveText("苹果");
		expect(await box.locator(".cm-live-table th").first().evaluate((node) => getComputedStyle(node).textAlign)).toBe("left");
		expect(await box.locator(".cm-live-table td").nth(1).evaluate((node) => getComputedStyle(node).textAlign)).toBe("right");

		// A click puts a cell into its text; typing there changes that cell and nothing else.
		const cell = box.locator(".cm-live-table td").first();
		await cell.click();
		await expect(cell).toHaveText("**苹果**");
		await loomPage.keyboard.press("End");
		await loomPage.keyboard.type("干");
		await expect.poll(onDisk).toBe(original.replace("**苹果**", "**苹果**干"));
		// Focus stays in the cell while the table redraws around the edit.
		await loomPage.keyboard.type("!");
		await expect.poll(onDisk).toBe(original.replace("**苹果**", "**苹果**干!"));

		// Enter goes down a row, Tab across, and both leave the first cell showing its result.
		await loomPage.keyboard.press("Enter");
		await expect(box.locator(".cm-live-table td").nth(2)).toBeFocused();
		await expect(box.locator(".cm-live-table td strong")).toHaveText("苹果");
		await loomPage.keyboard.press("Tab");
		await expect(box.locator(".cm-live-table td").nth(3)).toBeFocused();
		await loomPage.keyboard.press("ControlOrMeta+a");
		await loomPage.keyboard.type("a | b");
		// A pipe typed in a cell is escaped, so the table keeps its shape.
		await expect.poll(onDisk).toBe(original.replace("**苹果**", "**苹果**干!").replace("12 |", "a \\| b |"));

		// Undo is the file's: it takes the cell's text back.
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(async () => (await onDisk()).includes("a \\| b")).toBe(false);

		// A row and a column are added at the end, and the new cell takes the caret.
		await box.locator(".cm-live-table-add-row").click({ force: true });
		await expect(box.locator(".cm-live-table tr")).toHaveCount(4);
		await expect(box.locator(".cm-live-table tr").last().locator("td").first()).toBeFocused();
		await loomPage.keyboard.type("新");
		await box.locator(".cm-live-table-add-column").click({ force: true });
		await expect(box.locator(".cm-live-table th")).toHaveCount(3);
		await expect.poll(async () => (await onDisk()).includes("| 名称 | 数量 |  |")).toBe(true);
		const grown = await onDisk();
		expect(grown).toContain("| :--- | ---: | --- |");
		expect(grown).toContain("| 新 |  |  |");

		// Escape leaves the table for the text after it.
		await loomPage.keyboard.press("Escape");
		await expect(box.locator(".cm-live-table")).toHaveCount(1);

		// From the line after the table, ArrowUp steps into its last row, and ArrowDown from the line before steps
		// into its first, as the arrow keys do through text.
		// Put the caret on a line by clicking it, as a person would.
		await box.locator(".cm-line").filter({ hasText: "结尾" }).click();
		await loomPage.keyboard.press("ArrowUp"); // The blank line between them.
		await loomPage.keyboard.press("ArrowUp"); // Into the last row.
		await expect(box.locator(".cm-live-table tr").last().locator("td").first()).toBeFocused();
		await loomPage.keyboard.press("Escape");
		await box.locator(".cm-line").filter({ hasText: "# 表" }).click();
		await loomPage.keyboard.press("ArrowDown"); // The blank line after the heading.
		await loomPage.keyboard.press("ArrowDown"); // Into the header row.
		await expect(box.locator(".cm-live-table th").first()).toBeFocused();

		const focusedRow = () => loomPage.evaluate(() => (document.activeElement as HTMLElement).dataset.row ?? "none");
		// A click in the space above a table is a click on the table: it goes to the nearest cell and never turns the
		// table into its source. (The strip below and the one at the right are the buttons that add a row or a column.)
		// A click just outside is a click on the text beside it.
		const around = (await box.locator(".cm-live-table").boundingBox())!;
		await box.locator(".cm-line").first().click();
		await loomPage.mouse.click(around.x + 40, around.y + 3);
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		expect(await focusedRow()).toBe("0");
		for (const offset of [-2, around.height + 2]) {
			await box.locator(".cm-line").first().click();
			await loomPage.mouse.click(around.x + 40, around.y + offset);
			await expect(box.locator(".cm-live-table")).toHaveCount(1);
			expect(await focusedRow()).toBe("none");
		}

		// The arrow keys stop at the edges of a table: Up in the first row goes to the text above, Down in the last row
		// to the text below, and neither goes round into the table again.
		await box.locator(".cm-live-table th").first().click();
		await loomPage.keyboard.press("ArrowUp");
		expect(await focusedRow()).toBe("none");
		for (let i = 0; i < 4; i++) await loomPage.keyboard.press("ArrowUp");
		expect(await focusedRow()).toBe("none");
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		await box.locator(".cm-live-table td").last().click();
		await loomPage.keyboard.press("ArrowDown");
		expect(await focusedRow()).toBe("none");
		for (let i = 0; i < 4; i++) await loomPage.keyboard.press("ArrowDown");
		expect(await focusedRow()).toBe("none");
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		await box.locator(".cm-live-table td").last().click();
		await loomPage.keyboard.press("ArrowRight");
		expect(await focusedRow()).toBe("none");

		// Left and right arrows enter the table at its first or last cell, never as source.
		await box.locator(".cm-line").filter({ hasText: "# 表" }).click();
		await loomPage.keyboard.press("End");
		await loomPage.keyboard.press("ArrowRight"); // The blank line.
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		await loomPage.keyboard.press("ArrowRight"); // Into the table.
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		await expect(box.locator(".cm-live-table th").first()).toBeFocused();
		await box.locator(".cm-live-table td").last().click();
		await loomPage.keyboard.press("ArrowRight"); // Out of the last cell, to the text after the table.
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		expect(await focusedRow()).toBe("none");
		await loomPage.keyboard.press("ArrowLeft"); // Back into the last cell.
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		await expect(box.locator(".cm-live-table td").last()).toBeFocused();

		// A selection that runs over the table leaves it drawn: dragging or Shift+arrows never show its source.
		await box.locator(".cm-line").filter({ hasText: "# 表" }).click();
		await loomPage.keyboard.press("End");
		await loomPage.keyboard.press("Shift+ArrowDown");
		await loomPage.keyboard.press("Shift+ArrowDown");
		await loomPage.keyboard.press("Shift+ArrowDown");
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		await box.press("ControlOrMeta+a");
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		const unchanged = await onDisk();
		await box.press("ArrowLeft");
		expect(await onDisk()).toBe(unchanged);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("table cells render links, formulas and missing references, and a narrow column keeps its words whole", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-table-cells-e2e-"));
	const file = join(root, "格.md");
	const table = [
		"| 链接 | 公式 | 很长的说明 | 代码 | 缺失 |",
		"| --- | :-: | --- | --- | --- |",
		"| [[目标]] | $x^2$ | 这是一段相当长的说明文字，用来看单元格里的文字是不是会按列宽正常换行而不是撑破整张表格的宽度 | `a` | [[不存在]] |",
	].join("\n");
	const original = ["# 格", "", table, "", "结尾有 `code` 一段", ""].join("\n");
	await writeFile(file, original);
	await writeFile(join(root, "目标.md"), "# 目标\n");
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "格.md" }).first().click();
		await loomPage.getByRole("tab", { name: "Source" }).click();
		const box = loomPage.getByRole("textbox", { name: "Edit 格.md" });

		const cells = box.locator(".cm-live-table td");
		await expect(cells).toHaveCount(5);
		// A link to a library file is a link, a missing one is marked, and a formula is typeset.
		await expect(cells.nth(0).locator("a[data-asset-id]")).toHaveText("目标");
		await expect(cells.nth(1).locator(".katex")).toHaveCount(1);
		await expect(cells.nth(3).locator("code")).toHaveText("a");
		// Inline code in a cell has the same light background and type as in the text.
		const codeLook = (locator: import("@playwright/test").Locator) => locator.evaluate((node) => {
			const style = getComputedStyle(node);
			return { background: style.backgroundColor, family: style.fontFamily };
		});
		const inCell = await codeLook(cells.nth(3).locator("code"));
		expect(inCell.background).not.toBe("rgba(0, 0, 0, 0)");
		await expect(box.locator(".cm-live-code").first()).toBeVisible();
		expect(inCell).toEqual(await codeLook(box.locator(".cm-live-code").first()));
		await expect(cells.nth(4).locator(".markdown-broken-reference")).toHaveText("不存在");
		// A narrow column keeps a short word on one line, and the cell is as wide as its word.
		for (const header of await box.locator(".cm-live-table th").all()) {
			const size = await header.evaluate((node) => {
				const range = document.createRange();
				range.selectNodeContents(node);
				const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
				return { lines, fits: node.scrollWidth <= node.clientWidth + 1 };
			});
			expect(size, await header.innerText()).toEqual({ lines: 1, fits: true });
		}
		// Editing a cell shows its source in the same type at the same size, and nothing around it moves.
		const look = () => box.locator(".cm-live-table th, .cm-live-table td").evaluateAll((all) => all.map((cell) => {
			const rect = cell.getBoundingClientRect();
			const style = getComputedStyle(cell);
			return { size: style.fontSize, family: style.fontFamily, width: Math.round(rect.width), height: Math.round(rect.height) };
		}));
		const resting = await look();
		await cells.nth(2).click();
		await expect(cells.nth(2)).toBeFocused();
		expect(await look()).toEqual(resting);
		await cells.nth(0).click();
		await expect(cells.nth(0)).toBeFocused();
		expect(await look()).toEqual(resting);
		// A click on what a cell shows, a link or code or a formula, edits that cell. The content is swapped for the
		// source as the cell takes the focus, so the clicked element is gone by the time the click reaches the table.
		for (const index of [0, 1, 3, 4]) {
			await box.locator(".cm-line").filter({ hasText: "结尾" }).click();
			await expect(cells.nth(index).locator("a, code, .katex-html, .markdown-broken-reference").first()).toBeVisible();
			await cells.nth(index).locator("a, code, .katex-html, .markdown-broken-reference").first().click();
			await expect(cells.nth(index)).toBeFocused();
		}
		// A plain click edits the cell, as it does for a link in the text, and shows its source.
		await cells.nth(0).click();
		await expect(cells.nth(0)).toHaveText("[[目标]]");
		expect(await readFile(file, "utf8")).toBe(original);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("clicking the text between two tables keeps both drawn", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-two-tables-e2e-"));
	const original = [
		"## 表格", "", "| 元素 | 写法 |", "| :--- | :---: |", "| 代码块 | a |", "", "对齐试一下：左列靠左。", "", "| 左 | 中 |", "| :--- | :---: |", "| a | b |", "", "结尾", "",
	].join("\n");
	const file = join(root, "二.md");
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "二.md" }).first().click();
		await loomPage.getByRole("tab", { name: "Source" }).click();
		const box = loomPage.getByRole("textbox", { name: "Edit 二.md" });
		await expect(box.locator(".cm-live-table")).toHaveCount(2);

		// Every point from the bottom of the first table to the top of the second, in three columns: a click there is
		// a click on the text or on the blank lines, and never opens a table.
		const tables = await box.locator(".cm-live-table").evaluateAll((all) => all.map((table) => table.getBoundingClientRect()).map((rect) => ({ top: rect.top, bottom: rect.bottom, left: rect.left })));
		for (const x of [2, 120, 300]) {
			for (let y = Math.ceil(tables[0].bottom); y < tables[1].top; y += 4) {
				await box.locator(".cm-line").first().click();
				await loomPage.mouse.click(tables[0].left + x, y);
				await expect(box.locator(".cm-live-table"), `click at ${x},${Math.round(y - tables[0].bottom)}`).toHaveCount(2);
			}
		}
		// Holding Right through the text between them goes into each table by its cells and out again, and neither
		// table is ever shown as source on the way.
		await box.locator(".cm-line").filter({ hasText: "## 表格" }).click();
		await loomPage.keyboard.press("End");
		const seen = new Set<string>();
		for (let i = 0; i < 160; i++) {
			await loomPage.keyboard.press("ArrowRight");
			expect(await box.locator(".cm-live-table").count(), `after ${i + 1} presses`).toBe(2);
			seen.add(await loomPage.evaluate(() => { const a = document.activeElement as HTMLElement; return a.dataset.row !== undefined ? `${a.tagName}${a.dataset.row},${a.dataset.column}` : "text"; }));
		}
		expect(seen.has("TH0,0")).toBe(true);
		expect(seen.has("TD1,1")).toBe(true);
		expect(await readFile(file, "utf8")).toBe(original);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a table at the start or end of the file gets a blank line when the caret leaves it", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-table-edges-e2e-"));
	const table = ["| 名称 | 数量 |", "| :--- | ---: |", "| 苹果 | 3 |"].join("\n");
	const first = join(root, "头.md");
	const last = join(root, "尾.md");
	await writeFile(first, `${table}\n\n中间`);
	await writeFile(last, `中间\n\n${table}`);
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
		const focusedRow = () => loomPage.evaluate(() => (document.activeElement as HTMLElement).dataset.row ?? "none");
		const open = async (name: string) => {
			await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: name }).first().click();
			await loomPage.getByRole("tab", { name: "Source" }).click();
			const box = loomPage.getByRole("textbox", { name: `Edit ${name}` });
			// The caret starts at the top of the file, which is inside a table that begins there: move it out first.
			await box.locator(".cm-line").filter({ hasText: "中间" }).click();
			await expect(box.locator(".cm-live-table")).toHaveCount(1);
			return box;
		};

		// Nothing is above the table: Up in its first row adds a line there and the caret goes onto it.
		let box = await open("头.md");
		await box.locator(".cm-live-table th").first().click();
		await loomPage.keyboard.press("ArrowUp");
		expect(await focusedRow()).toBe("none");
		await expect.poll(() => readFile(first, "utf8")).toBe(`\n${table}\n\n中间`);
		await loomPage.keyboard.type("上");
		await expect.poll(() => readFile(first, "utf8")).toBe(`上\n${table}\n\n中间`);
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		// A table with a line above it gets no extra one.
		await box.locator(".cm-live-table th").first().click();
		await loomPage.keyboard.press("ArrowUp");
		await loomPage.keyboard.type("!");
		await expect.poll(() => readFile(first, "utf8")).toBe(`上!\n${table}\n\n中间`);

		// Nothing is below it either.
		box = await open("尾.md");
		await box.locator(".cm-live-table td").last().click();
		await loomPage.keyboard.press("ArrowDown");
		expect(await focusedRow()).toBe("none");
		// A blank line, then the line for the caret: text on the line right after a table would be one more row of it.
		await expect.poll(() => readFile(last, "utf8")).toBe(`中间\n\n${table}\n\n`);
		await loomPage.keyboard.type("下");
		await expect.poll(() => readFile(last, "utf8")).toBe(`中间\n\n${table}\n\n下`);
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		// Undo takes the added line away with the text typed on it.
		await loomPage.keyboard.press("ControlOrMeta+z");
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(() => readFile(last, "utf8")).toBe(`中间\n\n${table}`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("up and down move by line even when the caret's formula source wraps the line", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-wrapline-e2e-"));
	await writeFile(join(root, "行.md"), ["第一行", "", "单元格里也能放行内代码和公式：$\\sqrt{2}\\approx1.414$、`npm run dev`。", "", "末行", ""].join("\n"));
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "行.md" }).first().click();
		await loomPage.getByRole("tab", { name: "Source" }).click();
		const box = loomPage.getByRole("textbox", { name: "Edit 行.md" });
		const lineOfCaret = async () => {
			await loomPage.waitForTimeout(120);
			return loomPage.evaluate(() => {
				const selection = getSelection();
				const node = selection?.anchorNode;
				const line = (node instanceof Element ? node : node?.parentElement)?.closest(".cm-line");
				return line ? [...document.querySelectorAll(".cm-content > .cm-line")].indexOf(line) : -1;
			});
		};
		const target = box.locator(".cm-line").filter({ hasText: "npm run dev" });
		const placeInFormula = async () => {
			const rect = (await target.boundingBox())!;
			await loomPage.mouse.click(rect.x + 232, rect.y + 12);
			expect(await lineOfCaret()).toBe(2);
			// The source of the formula is showing and the line has gone onto two rows.
			await expect(box.locator(".cm-live-math-source")).toHaveCount(1);
		};

		// Down from inside the formula goes to the next line, not to the end of this one.
		await placeInFormula();
		await loomPage.keyboard.press("ArrowDown");
		expect(await lineOfCaret()).toBe(3);
		await loomPage.keyboard.press("ArrowDown");
		expect(await lineOfCaret()).toBe(4);
		// Up from the line below, back through it.
		await loomPage.keyboard.press("ArrowUp");
		expect(await lineOfCaret()).toBe(3);
		await loomPage.keyboard.press("ArrowUp");
		expect(await lineOfCaret()).toBe(2);
		await loomPage.keyboard.press("ArrowUp");
		expect(await lineOfCaret()).toBe(1);
		// Up from inside the formula goes to the line above.
		await placeInFormula();
		await loomPage.keyboard.press("ArrowUp");
		expect(await lineOfCaret()).toBe(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("up and down stop on a line that is only inline code", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-codeline-e2e-"));
	await writeFile(join(root, "码.md"), ["上一行文字", "", "` dsadsa `", "", "**粗体一行**", "", "下一行文字", ""].join("\n"));
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "码.md" }).first().click();
		await loomPage.getByRole("tab", { name: "Source" }).click();
		const box = loomPage.getByRole("textbox", { name: "Edit 码.md" });
		const lineOfCaret = async () => {
			await loomPage.waitForTimeout(120);
			return loomPage.evaluate(() => {
				const selection = getSelection();
				const node = selection?.anchorNode;
				const line = (node instanceof Element ? node : node?.parentElement)?.closest(".cm-line");
				return line ? [...document.querySelectorAll(".cm-content > .cm-line")].indexOf(line) : -1;
			});
		};
		// Line by line down: the blank line, the line of code, the blank line, the bold line, and so on.
		await box.locator(".cm-line").first().click();
		const down: number[] = [];
		for (let i = 0; i < 6; i++) {
			await loomPage.keyboard.press("ArrowDown");
			down.push(await lineOfCaret());
		}
		expect(down).toEqual([1, 2, 3, 4, 5, 6]);
		const up: number[] = [];
		for (let i = 0; i < 6; i++) {
			await loomPage.keyboard.press("ArrowUp");
			up.push(await lineOfCaret());
		}
		expect(up).toEqual([5, 4, 3, 2, 1, 0]);
		// A hidden mark takes no room: the code sits where the line starts, as it did before.
		await box.locator(".cm-line").first().click();
		const marks = await box.locator(".cm-live-hidden").evaluateAll((all) => all.map((mark) => mark.getBoundingClientRect().width));
		expect(Math.max(...marks)).toBeLessThan(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

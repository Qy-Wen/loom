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
		// CodeMirror keeps one `.cm-line` per line; read the document back by joining them.
		const box = loomPage.getByRole("textbox", { name: "Edit 笔记.md" });
		const editorText = () => box.evaluate((node) => [...node.querySelectorAll(".cm-line")].map((line) => line.textContent ?? "").join("\n"));
		await expect.poll(editorText).toBe("# 标题\n\n原文\n");
		const status = loomPage.locator(".markdown-editor-status");
		await expect(status).toHaveCount(0);

		// Opening and leaving without typing writes nothing.
		expect(await readFile(file, "utf8")).toBe("# 标题\n\n原文\n");

		// Typing saves after a pause, and the untouched text stays as it was.
		await box.click();
		await box.press("ControlOrMeta+End");
		await box.pressSequentially("新增一行\n");
		await expect(status).toHaveCount(0);
		await expect.poll(() => readFile(file, "utf8"), { timeout: 10_000 }).toBe("# 标题\n\n原文\n新增一行\n");
		await expect(status).toHaveCount(0);

		// Reading shows the same text in the same editor.
		await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
		await expect(box).toContainText("新增一行");
		await loomPage.getByRole("button", { name: "Edit mode", exact: true }).click();

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
		await expect(status).toHaveCount(0);

		// Overwrite writes the editor's text.
		await box.click();
		await box.press("ControlOrMeta+End");
		await box.pressSequentially("甲");
		await writeFile(file, "# 标题\n\n第三次外部修改\n");
		await expect(status.getByRole("button", { name: "Overwrite" })).toBeVisible({ timeout: 15_000 });
		await status.getByRole("button", { name: "Overwrite" }).click();
		await expect.poll(() => readFile(file, "utf8")).toBe("# 标题\n\n第二次外部修改\n甲");
		await expect(status).toHaveCount(0);
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
		const box = loomPage.getByRole("textbox", { name: "Edit live.md" });
		await expect(box).toBeVisible();

		// A file just opened has its caret at the start but nobody in the editor: the first line shows as a heading.
		await expect(box.locator(".cm-live-h1")).toHaveCount(1);
		await expect(box.locator(".cm-line").first().locator(".cm-live-hidden")).toHaveText("# ");

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
		await expect(loomPage.locator(".cm-content").getByRole("heading", { name: "结尾" })).toBeInViewport({ timeout: 10_000 });

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

test("dragging across code paints the selection above the code block background", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const library = () => loomPage.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(library).toBeTruthy();
	const file = join((await library())!, "code.md");
	const original = "```js\nconst    alpha = 1;\nconst    beta = 2;\n```\n";
	await writeFile(file, original);
	await loomPage.locator(".library-sidebar .asset-row").filter({ hasText: "code.md" }).click();
	const editor = loomPage.locator(".markdown-editor-input");
	const firstLine = editor.locator(".cm-live-codeblock").filter({ hasText: "alpha" });
	const lastLine = editor.locator(".cm-live-codeblock").filter({ hasText: "beta" });
	await firstLine.click({ position: { x: 16, y: 8 } });
	const first = (await firstLine.boundingBox())!;
	const last = (await lastLine.boundingBox())!;
	// Sample the spaces after `const`, away from both the text and the caret.
	const clip = { x: Math.floor(first.x + 68), y: Math.floor(first.y + first.height / 2), width: 2, height: 2 };
	const sampledPixels = async () => {
		const png = await loomPage.screenshot({ clip, scale: "css" });
		return electronApp!.evaluate(({ nativeImage }, encoded) =>
			nativeImage.createFromBuffer(Buffer.from(encoded, "base64")).toBitmap().toString("hex"), png.toString("base64"));
	};
	const unselected = await sampledPixels();
	await loomPage.mouse.move(first.x + 16, first.y + first.height / 2);
	await loomPage.mouse.down();
	await loomPage.mouse.move(last.x + 116, last.y + last.height / 2, { steps: 10 });
	await expect(editor.locator(".cm-selectionBackground").first()).toBeVisible();
	await expect.poll(sampledPixels).not.toBe(unselected);
	await loomPage.mouse.up();
	await expect.poll(() => loomPage.evaluate(() => getSelection()?.toString())).toContain("alpha = 1;\nconst    beta");
	await expect.poll(sampledPixels).not.toBe(unselected);
	expect(await readFile(file, "utf8")).toBe(original);
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

test("rows, columns and alignment change from a table's context menu", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-table-menu-e2e-"));
	const table = ["| 名称 | 数量 |", "| :--- | ---: |", "| 苹果 | 3 |", "| 梨 | 12 |"].join("\n");
	const file = join(root, "菜.md");
	// The table is the first thing in the file, so the caret starts inside it.
	await writeFile(file, `${table}\n\n结尾\n`);
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "菜.md" }).first().click();
		const box = loomPage.getByRole("textbox", { name: "Edit 菜.md" });
		const onDisk = () => readFile(file, "utf8");
		const lines = async () => (await box.locator(".cm-line").allInnerTexts()).join("\n");
		const choose = (label: string) => electronApp!.evaluate(({ Menu }, wanted) => {
			Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
				this.items.find((item) => item.label === wanted && item.enabled)?.click();
				options?.callback?.();
			};
		}, label);

		// Opening the file with the caret in the table leaves it drawn.
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		await expect(box.locator(".cm-live-table td")).toHaveCount(4);

		// Alignment is set from the menu, on the column of the cell, and written in the delimiter row alone.
		await choose("Align center");
		await box.locator(".cm-live-table td").first().click({ button: "right" });
		await expect(box.locator(".cm-live-table th").first()).toHaveCSS("text-align", "center");
		await expect.poll(onDisk).toBe(`| 名称 | 数量 |\n| :-: | ---: |\n| 苹果 | 3 |\n| 梨 | 12 |\n\n结尾\n`);
		await expect(box.locator(".cm-live-table td").first()).toHaveCSS("text-align", "center");
		await expect(box.locator(".cm-live-table td").nth(1)).toHaveCSS("text-align", "right");
		// The other column is untouched by it, and the choice the column already has takes the alignment off.
		await choose("Align right");
		await box.locator(".cm-live-table td").nth(1).click({ button: "right" });
		await expect.poll(onDisk).toBe(`| 名称 | 数量 |\n| :-: | --- |\n| 苹果 | 3 |\n| 梨 | 12 |\n\n结尾\n`);
		await choose("Align left");
		await box.locator(".cm-live-table td").nth(1).click({ button: "right" });
		await expect.poll(onDisk).toBe(`| 名称 | 数量 |\n| :-: | :--- |\n| 苹果 | 3 |\n| 梨 | 12 |\n\n结尾\n`);
		await choose("Align center");
		await box.locator(".cm-live-table td").first().click({ button: "right" });
		await expect.poll(onDisk).toBe(`| 名称 | 数量 |\n| --- | :--- |\n| 苹果 | 3 |\n| 梨 | 12 |\n\n结尾\n`);
		await choose("Align right");
		await box.locator(".cm-live-table td").nth(1).click({ button: "right" });
		await choose("Align left");
		await box.locator(".cm-live-table td").first().click({ button: "right" });
		await expect.poll(onDisk).toBe(`| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |\n| 梨 | 12 |\n\n结尾\n`);
		// The menu marks the alignment the column has.
		const marked = async (cell: import("@playwright/test").Locator) => {
			await electronApp!.evaluate(({ Menu }) => {
				Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
					(globalThis as unknown as { __marked: string }).__marked = this.items.filter((item) => item.checked).map((item) => item.label).join("|");
					options?.callback?.();
				};
			});
			await cell.click({ button: "right" });
			return electronApp!.evaluate(() => (globalThis as unknown as { __marked: string }).__marked);
		};
		expect(await marked(box.locator(".cm-live-table td").first())).toBe("Align left");
		expect(await marked(box.locator(".cm-live-table td").nth(1))).toBe("Align right");
		// There is no way back to a source view of the table: no button, no menu entry.
		await expect(box.locator(".cm-live-table-source")).toHaveCount(0);
		await loomPage.keyboard.press("ControlOrMeta+/");
		await expect(box.locator(".cm-live-table")).toHaveCount(1);

		// The context menu: a row above and below, a column left and right.
		const second = box.locator(".cm-live-table td").nth(2); // 梨, row 2
		await choose("Insert row above");
		await second.click({ button: "right" });
		await expect.poll(onDisk).toBe(`| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |\n|  |  |\n| 梨 | 12 |\n\n结尾\n`);
		await choose("Insert row below");
		await box.locator(".cm-live-table td").nth(0).click({ button: "right" });
		await expect.poll(onDisk).toBe(`| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |\n|  |  |\n|  |  |\n| 梨 | 12 |\n\n结尾\n`);
		await choose("Insert column to the left");
		await box.locator(".cm-live-table th").first().click({ button: "right" });
		await expect(box.locator(".cm-live-table th")).toHaveCount(3);
		await choose("Insert column to the right");
		await box.locator(".cm-live-table th").last().click({ button: "right" });
		await expect(box.locator(".cm-live-table th")).toHaveCount(4);

		// Delete them again. One column at a time, each checked against the file.
		await expect(box.locator(".cm-live-table th")).toHaveCount(4);
		await choose("Delete column");
		await box.locator(".cm-live-table th").last().click({ button: "right" });
		await expect(box.locator(".cm-live-table th")).toHaveCount(3);
		await box.locator(".cm-live-table th").first().click({ button: "right" });
		await expect(box.locator(".cm-live-table th")).toHaveCount(2);
		await expect(box.locator(".cm-live-table th").first()).toHaveText("名称");
		// Two empty rows and the two of ours: delete the empty ones, each time from a cell of that row.
		await choose("Delete row");
		await box.locator(".cm-live-table td").nth(2).click({ button: "right" }); // row 2, one of the empty ones
		await expect(box.locator(".cm-live-table td")).toHaveCount(6);
		await box.locator(".cm-live-table td").nth(2).click({ button: "right" });
		await expect(box.locator(".cm-live-table td")).toHaveCount(4);
		await expect.poll(onDisk).toBe(`| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |\n| 梨 | 12 |\n\n结尾\n`);

		// The menu says what is possible: no row to delete at the header, and the last column stays.
		const offered = async (cell: import("@playwright/test").Locator) => {
			await electronApp!.evaluate(({ Menu }) => {
				Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
					(globalThis as unknown as { __menu: string }).__menu = this.items.filter((item) => item.enabled && item.label).map((item) => item.label).join("|");
					options?.callback?.();
				};
			});
			await cell.click({ button: "right" });
			return electronApp!.evaluate(() => (globalThis as unknown as { __menu: string }).__menu);
		};
		expect(await offered(box.locator(".cm-live-table th").first())).not.toContain("Delete row");
		expect(await offered(box.locator(".cm-live-table th").first())).toContain("Delete column");
		expect(await offered(box.locator(".cm-live-table td").first())).toContain("Delete row");
		expect(await onDisk()).toBe(`| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |\n| 梨 | 12 |\n\n结尾\n`);
		await choose("Delete column");
		await box.locator(".cm-live-table th").first().click({ button: "right" });
		await expect(box.locator(".cm-live-table th")).toHaveCount(1);
		expect(await offered(box.locator(".cm-live-table th").first())).not.toContain("Delete column");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a selection that reaches into a table takes the whole table, which shows as selected and never deletes half of it", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-selection-e2e-"));
	const table = ["| 名称 | 数量 |", "| :--- | ---: |", "| 苹果 | 3 |", "| 梨 | 12 |"].join("\n");
	const original = ["上文一行", "", table, "", "下文一行", ""].join("\n");
	const file = join(root, "选.md");
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "选.md" }).first().click();
		const box = loomPage.getByRole("textbox", { name: "Edit 选.md" });
		const above = box.locator(".cm-line").filter({ hasText: "上文一行" });
		const tableBox = box.locator(".cm-live-table");
		const onDisk = () => readFile(file, "utf8");
		await expect(tableBox).toHaveCount(1);
		const background = () => tableBox.locator("table").evaluate((node) => getComputedStyle(node).backgroundColor);
		const resting = await background();

		// Drag from the text above into the middle of the table: the table is in the selection, as a whole.
		const start = (await above.boundingBox())!;
		const target = (await tableBox.boundingBox())!;
		await loomPage.mouse.move(start.x + 20, start.y + 8);
		await loomPage.mouse.down();
		await loomPage.mouse.move(target.x + 60, target.y + target.height / 2, { steps: 8 });
		await loomPage.mouse.up();
		await expect(tableBox).toHaveClass(/cm-live-table-selected/);
		await expect.poll(background).not.toBe(resting);
		// The header and the body are one colour, and no caret is drawn along the table.
		const headBackground = await tableBox.locator("th").first().evaluate((node) => getComputedStyle(node).backgroundColor);
		expect(headBackground).toBe("rgba(0, 0, 0, 0)");
		await expect(loomPage.locator(".cm-cursor")).toHaveCount(0);
		await expect(tableBox).toHaveCount(1);
		// Deleting takes the table and the selected text, and leaves no half of it.
		await loomPage.keyboard.press("Delete");
		await expect.poll(onDisk).toBe("上\n\n下文一行\n");
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(onDisk).toBe(original);
		await expect(tableBox).toHaveCount(1);

		// Shift+Down from the line above does the same, one step at a time.
		await above.click();
		await loomPage.keyboard.press("End");
		for (let i = 0; i < 2; i++) await loomPage.keyboard.press("Shift+ArrowDown");
		await expect(tableBox).toHaveCount(1);
		await expect(tableBox).toHaveClass(/cm-live-table-selected/);
		await loomPage.keyboard.press("Delete");
		// From the end of the line above, the selection holds the line break, the blank line and the table.
		await expect.poll(onDisk).toBe("上文一行\n下文一行\n");
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(onDisk).toBe(original);

		// A selection that stays in the text beside the table does not take it, and it is not marked.
		await above.click();
		await loomPage.keyboard.press("Home");
		await loomPage.keyboard.press("Shift+End");
		await expect(tableBox).not.toHaveClass(/cm-live-table-selected/);
		expect(await background()).toBe(resting);

		// The mark goes when the selection does.
		await above.click();
		await loomPage.keyboard.press("ControlOrMeta+a");
		await expect(tableBox).toHaveClass(/cm-live-table-selected/);
		await loomPage.keyboard.press("ArrowLeft");
		await expect(tableBox).not.toHaveClass(/cm-live-table-selected/);
		expect(await onDisk()).toBe(original);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a drag selection leaves what it sweeps over drawn until the button is let go", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-drag-e2e-"));
	const original = ["开头一行", "", "公式 $x^2$ 和 **粗体** 以及 `代码` 再来 [[目标]] 结束", "", "末尾一行", ""].join("\n");
	const file = join(root, "拖.md");
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "拖.md" }).first().click();
		const box = loomPage.getByRole("textbox", { name: "Edit 拖.md" });
		const middle = box.locator(".cm-line").filter({ hasText: "再来" });
		await expect(box.locator(".cm-live-math")).toHaveCount(1);
		const hiddenMarks = () => box.locator(".cm-live-hidden").count();
		const restingMarks = await hiddenMarks();
		const restingHeight = (await middle.boundingBox())!.height;

		// Press at the start of the opening line and drag through the middle line to the end of the closing one.
		const first = (await box.locator(".cm-line").first().boundingBox())!;
		const line = (await middle.boundingBox())!;
		const last = (await box.locator(".cm-line").filter({ hasText: "末尾一行" }).boundingBox())!;
		await loomPage.mouse.move(first.x + 4, first.y + 8);
		await loomPage.mouse.down();
		await loomPage.mouse.move(line.x + line.width - 10, line.y + 8, { steps: 10 });
		// Mid-drag: the selection is over the formula, the bold text, the code and the link, and all stay drawn.
		await expect(box.locator(".cm-live-math")).toHaveCount(1);
		await expect(box.locator(".cm-live-math-source")).toHaveCount(0);
		expect(await hiddenMarks()).toBe(restingMarks);
		await loomPage.mouse.move(last.x + 40, last.y + 8, { steps: 6 });
		expect(await hiddenMarks()).toBe(restingMarks);
		expect((await middle.boundingBox())!.height).toBe(restingHeight);
		await expect(box.locator(".cm-live-math")).toHaveCount(1);

		// Let go: the selection stands and the elements it covers open to source.
		await loomPage.mouse.up();
		await expect(box.locator(".cm-live-math-source")).toHaveCount(1);
		await expect(box.locator(".cm-live-math")).toHaveCount(0);
		expect(await hiddenMarks()).toBeLessThan(restingMarks);
		expect(await readFile(file, "utf8")).toBe(original);

		// Not for an instant either: from the moment the button goes down, every frame shows the symbols as they were.
		await box.locator(".cm-line").first().click();
		await loomPage.evaluate(() => {
			const lines = Array.from(document.querySelectorAll(".cm-content .cm-line"));
			const target = lines.find((line) => line.textContent?.includes("再来"));
			const count = () => document.querySelectorAll(".cm-content .cm-live-hidden").length;
			const log: number[] = [];
			const note = () => log.push(count());
			(window as unknown as { __frames: number[] }).__frames = log;
			new MutationObserver(note).observe(target!.closest(".cm-content")!, { childList: true, subtree: true, attributes: true });
		});
		const pressedAt = (await middle.locator(".cm-live-strong").first().boundingBox())!;
		await loomPage.mouse.move(pressedAt.x + 2, pressedAt.y + pressedAt.height / 2);
		await loomPage.mouse.down();
		await loomPage.waitForTimeout(120);
		await loomPage.mouse.move(pressedAt.x + 30, pressedAt.y + pressedAt.height / 2, { steps: 6 });
		await loomPage.waitForTimeout(120);
		const seen = await loomPage.evaluate(() => (window as unknown as { __frames: number[] }).__frames);
		await loomPage.mouse.up();
		// While the button was down the number of hidden symbols never changed from what it was at the press.
		expect(new Set(seen).size).toBeLessThanOrEqual(1);

		// The point the drag starts from is not opened either: press inside the bold text and drag away.
		await box.locator(".cm-line").first().click();
		const bold = (await middle.locator(".cm-live-strong, strong, .cm-live-bold").first().boundingBox())!;
		await loomPage.mouse.move(bold.x + bold.width / 2, bold.y + bold.height / 2);
		await loomPage.mouse.down();
		await loomPage.mouse.move(bold.x + bold.width / 2 + 60, bold.y + bold.height / 2, { steps: 6 });
		expect(await hiddenMarks()).toBe(restingMarks);
		expect((await middle.boundingBox())!.height).toBe(restingHeight);
		await loomPage.mouse.up();
		expect(await hiddenMarks()).toBeLessThan(restingMarks);

		// Let go with an edge at the bold text: the symbols around it are in the selection, so copying keeps them whole.
		await box.locator(".cm-line").first().click();
		const boldBox = (await middle.locator(".cm-live-strong").first().boundingBox())!;
		const lineBox = (await middle.boundingBox())!;
		await loomPage.mouse.move(boldBox.x + 2, boldBox.y + boldBox.height / 2);
		await loomPage.mouse.down();
		await loomPage.mouse.move(lineBox.x + lineBox.width - 4, lineBox.y + lineBox.height / 2, { steps: 8 });
		await loomPage.mouse.up();
		// What the browser holds as selected is what copying takes; the hidden symbols are text in it too.
		const picked = await loomPage.evaluate(() => window.getSelection()?.toString() ?? "");
		expect(picked.startsWith("**粗体**")).toBe(true);
		expect(picked.endsWith("结束")).toBe(true);

		// A plain click still opens what it touches at once, and typing during no drag is untouched.
		await box.locator(".cm-line").first().click();
		await expect(box.locator(".cm-live-math")).toHaveCount(1);
		await middle.locator(".katex-html").click();
		await expect(box.locator(".cm-live-math-source")).toHaveCount(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("pressing on an element that is already open to source does not close it while the button is down", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-press-e2e-"));
	const original = ["开头", "", "---", "", "一句 **粗体** 话", "", "结尾", ""].join("\n");
	const file = join(root, "按.md");
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "按.md" }).first().click();
		const box = loomPage.getByRole("textbox", { name: "Edit 按.md" });
		await expect(box.locator(".cm-live-rule")).toHaveCount(1);

		// Click the rule: it opens to its `---`. Pressing on that line again keeps it open the whole time.
		// The drawn rule is as tall as its source line, so opening it moves nothing.
		const drawnHeight = (await box.locator(".cm-line:has(.cm-live-rule)").boundingBox())!.height;
		await box.locator(".cm-live-rule").click();
		await expect(box.locator(".cm-live-rule")).toHaveCount(0);
		expect((await box.locator(".cm-line").filter({ hasText: /^---$/ }).boundingBox())!.height).toBeCloseTo(drawnHeight, 1);
		const dashes = box.locator(".cm-line").filter({ hasText: /^---$/ });
		await expect(dashes).toHaveCount(1);
		const at = (await dashes.boundingBox())!;
		for (let round = 0; round < 3; round++) {
			await loomPage.mouse.move(at.x + 6, at.y + at.height / 2);
			await loomPage.mouse.down();
			await loomPage.waitForTimeout(150);
			await expect(box.locator(".cm-live-rule")).toHaveCount(0);
			await loomPage.mouse.up();
			await expect(box.locator(".cm-live-rule")).toHaveCount(0);
		}

		// The same for bold text: open it, press on it, and its symbols stay. The symbols are outside the bold span.
		const line = box.locator(".cm-line").filter({ hasText: "一句" });
		const shown = () => line.evaluate((node) => {
			const copy = node.cloneNode(true) as HTMLElement;
			copy.querySelectorAll(".cm-live-hidden").forEach((hiddenNode) => hiddenNode.remove());
			return copy.textContent ?? "";
		});
		await box.locator(".cm-live-strong").click();
		await expect.poll(shown).toBe("一句 **粗体** 话");
		const bold = (await box.locator(".cm-live-strong").boundingBox())!;
		await loomPage.mouse.move(bold.x + bold.width / 2, bold.y + bold.height / 2);
		await loomPage.mouse.down();
		await loomPage.waitForTimeout(150);
		expect(await shown()).toBe("一句 **粗体** 话");
		await loomPage.mouse.up();
		expect(await shown()).toBe("一句 **粗体** 话");
		expect(await readFile(file, "utf8")).toBe(original);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rows and columns of a table move by their grips", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-table-move-e2e-"));
	const table = ["| 名称 | 数量 | 备注 |", "| :--- | ---: | :---: |", "| 苹果 | 3 | 红 |", "| 梨 | 12 | 黄 |", "| 桃 | 7 | 粉 |"].join("\n");
	const original = `上文\n\n${table}\n\n下文\n`;
	const file = join(root, "移.md");
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "移.md" }).first().click();
		const box = loomPage.getByRole("textbox", { name: "Edit 移.md" });
		const onDisk = () => readFile(file, "utf8");
		const cell = (row: number, column: number) => box.locator(`.cm-live-table [data-row="${row}"][data-column="${column}"]`);
		await expect(box.locator(".cm-live-table")).toHaveCount(1);

		// The grips show only from the table's edges: a column's above it, a row's to the left. Over the cells there are none.
		const table = box.locator(".cm-live-table table");
		await expect(box.locator(".cm-live-table-handle-row")).toBeHidden();
		await expect(box.locator(".cm-live-table-handle-column")).toBeHidden();
		await cell(2, 1).hover();
		await expect(box.locator(".cm-live-table-handle-row")).toBeHidden();
		await expect(box.locator(".cm-live-table-handle-column")).toBeHidden();
		const rect = (await table.boundingBox())!;
		const over = (await cell(2, 1).boundingBox())!;
		const headCell = (await cell(0, 1).boundingBox())!;
		// Above the second column, just over the table's top edge.
		await loomPage.mouse.move(headCell.x + headCell.width / 2 + 40, rect.y - 6);
		await expect(box.locator(".cm-live-table-handle-column")).toBeVisible();
		await expect(box.locator(".cm-live-table-handle-row")).toBeHidden();
		// Beside the third row, just left of the table's left edge.
		await loomPage.mouse.move(rect.x - 6, over.y + over.height / 2);
		await expect(box.locator(".cm-live-table-handle-row")).toBeVisible();
		await expect(box.locator(".cm-live-table-handle-column")).toBeHidden();
		// Beside the header there is no row grip.
		await loomPage.mouse.move(rect.x - 6, headCell.y + headCell.height / 2);
		await expect(box.locator(".cm-live-table-handle-row")).toBeHidden();
		// Away from the table there are none.
		await loomPage.mouse.move(5, 5);
		await expect(box.locator(".cm-live-table-handle-column")).toBeHidden();

		// The block behind the "add column" plus stays within the table's height: not above its top line.
		const plus = (await box.locator(".cm-live-table-add-column").boundingBox())!;
		expect(Math.abs(plus.y - rect.y)).toBeLessThan(1.5);
		expect(Math.abs(plus.y + plus.height - (rect.y + rect.height))).toBeLessThan(1.5);
		// It touches the table's right edge, as the "add row" block touches its bottom edge.
		expect(Math.abs(plus.x - (rect.x + rect.width))).toBeLessThan(1.5);
		const below = (await box.locator(".cm-live-table-add-row").boundingBox())!;
		expect(Math.abs(below.y - (rect.y + rect.height))).toBeLessThan(1.5);
		expect(Math.abs(below.x - rect.x)).toBeLessThan(1.5);
		expect(Math.abs(below.x + below.width - (rect.x + rect.width))).toBeLessThan(1.5);
		// The grips are small.
		await loomPage.mouse.move(headCell.x + headCell.width / 2, rect.y - 6);
		const small = (await box.locator(".cm-live-table-handle-column").boundingBox())!;
		expect(small.width).toBeLessThanOrEqual(24);
		expect(small.height).toBeLessThanOrEqual(14);

		// The grips lie outside the cells: the column's above the table and flat, the row's left of it and tall, each
		// centred on its column or row.
		await loomPage.mouse.move(headCell.x + headCell.width / 2, rect.y - 6);
		const columnGrip = (await box.locator(".cm-live-table-handle-column").boundingBox())!;
		expect(columnGrip.y + columnGrip.height).toBeLessThanOrEqual(rect.y);
		expect(columnGrip.width).toBeGreaterThan(columnGrip.height * 1.5);
		expect(Math.abs(columnGrip.x + columnGrip.width / 2 - (headCell.x + headCell.width / 2))).toBeLessThan(3);
		await loomPage.mouse.move(rect.x - 6, over.y + over.height / 2);
		const rowGrip = (await box.locator(".cm-live-table-handle-row").boundingBox())!;
		expect(rowGrip.x + rowGrip.width).toBeLessThanOrEqual(rect.x);
		expect(rowGrip.height).toBeGreaterThan(rowGrip.width * 1.5);
		expect(Math.abs(rowGrip.y + rowGrip.height / 2 - (over.y + over.height / 2))).toBeLessThan(3);
		await loomPage.mouse.move(5, 5);

		// Moves the pointer to a grip the way a hand does: to the table's edge beside the row or column, then onto the grip.
		const reach = async (kind: "row" | "column", index: number) => {
			const edge = (await table.boundingBox())!;
			const target = (await (kind === "row" ? cell(index, 0) : cell(0, index)).boundingBox())!;
			if (kind === "row") await loomPage.mouse.move(edge.x - 6, target.y + target.height / 2);
			else await loomPage.mouse.move(target.x + target.width / 2, edge.y - 6);
			const grip = box.locator(`.cm-live-table-handle-${kind}`);
			await expect(grip).toBeVisible();
			const at = (await grip.boundingBox())!;
			await loomPage.mouse.move(at.x + at.width / 2, at.y + at.height / 2, { steps: 4 });
			// Still shown with the pointer on it, though it is no longer beside the edge.
			await expect(grip).toBeVisible();
		};

		// The row or column a grip would move is framed while the pointer is on the grip.
		const frame = box.locator(".cm-live-table-frame");
		await expect(frame).toBeHidden();
		await reach("row", 2);
		await expect(frame).toBeVisible();
		const rowFrame = (await frame.boundingBox())!;
		const rowBox = (await cell(2, 0).boundingBox())!;
		expect(Math.abs(rowFrame.y - rowBox.y)).toBeLessThan(3);
		expect(Math.abs(rowFrame.height - rowBox.height)).toBeLessThan(4);
		expect(rowFrame.width).toBeGreaterThan(rowBox.width * 2);
		await loomPage.mouse.move(5, 5);
		await reach("column", 1);
		await expect(frame).toBeVisible();
		const columnFrame = (await frame.boundingBox())!;
		const columnBox = (await cell(0, 1).boundingBox())!;
		expect(Math.abs(columnFrame.x - columnBox.x)).toBeLessThan(3);
		expect(Math.abs(columnFrame.width - columnBox.width)).toBeLessThan(4);
		expect(columnFrame.height).toBeGreaterThan(columnBox.height * 2);
		await loomPage.mouse.move(5, 5);
		await expect(frame).toBeHidden();

		const drag = async (kind: "row" | "column", index: number, over: import("@playwright/test").Locator, to: "before" | "after") => {
			await reach(kind, index);
			const target = (await over.boundingBox())!;
			await loomPage.mouse.down();
			await loomPage.mouse.move(target.x + target.width / 2, target.y + (to === "before" ? 4 : target.height - 4), { steps: 8 });
			// While it is dragged the frame stays on the row or column that is being moved, not under the pointer.
			await expect(box.locator(".cm-live-table-frame")).toBeVisible();
			await loomPage.mouse.up();
			await expect(box.locator(".cm-live-table-frame")).toBeHidden();
		};

		// Row 1 (苹果) goes below row 3 (桃).
		await drag("row", 1, cell(3, 0), "after");
		await expect.poll(onDisk).toBe(`上文\n\n| 名称 | 数量 | 备注 |\n| :--- | ---: | :---: |\n| 梨 | 12 | 黄 |\n| 桃 | 7 | 粉 |\n| 苹果 | 3 | 红 |\n\n下文\n`);
		// Column 2 (备注) goes to the front, and its alignment with it.
		await drag("column", 2, cell(0, 0), "before");
		await expect.poll(onDisk).toBe(`上文\n\n| 备注 | 名称 | 数量 |\n| :---: | :--- | ---: |\n| 黄 | 梨 | 12 |\n| 粉 | 桃 | 7 |\n| 红 | 苹果 | 3 |\n\n下文\n`);
		await expect(cell(0, 0)).toHaveCSS("text-align", "center");
		await expect(cell(0, 2)).toHaveCSS("text-align", "right");

		// Undo puts each move back with one step.
		await box.locator(".cm-line").filter({ hasText: "下文" }).click();
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(onDisk).toBe(`上文\n\n| 名称 | 数量 | 备注 |\n| :--- | ---: | :---: |\n| 梨 | 12 | 黄 |\n| 桃 | 7 | 粉 |\n| 苹果 | 3 | 红 |\n\n下文\n`);
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(onDisk).toBe(original);

		// The header never takes a row's place: dragging the third row up to it leaves the row first among the others.
		await reach("row", 2);
		const head = (await cell(0, 0).boundingBox())!;
		await loomPage.mouse.down();
		await loomPage.mouse.move(head.x + 20, head.y + 4, { steps: 6 });
		await loomPage.mouse.up();
		await expect.poll(onDisk).toBe(`上文\n\n| 名称 | 数量 | 备注 |\n| :--- | ---: | :---: |\n| 梨 | 12 | 黄 |\n| 苹果 | 3 | 红 |\n| 桃 | 7 | 粉 |\n\n下文\n`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("dragging from one cell into another picks a block of cells that the menu, Delete and copy act on", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-table-pick-e2e-"));
	const rows = ["| 名称 | 数量 | 备注 | 价格 |", "| :--- | ---: | :-: | --- |", "| 苹果 | 3 | 红 | 5 |", "| 梨 | 12 | 黄 | 6 |", "| 桃 | 7 | 粉 | 8 |", "| 李 | 9 | 紫 | 4 |"];
	const original = `上文\n\n${rows.join("\n")}\n\n下文\n`;
	const file = join(root, "选.md");
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
		await loomPage.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: "选.md" }).first().click();
		const box = loomPage.getByRole("textbox", { name: "Edit 选.md" });
		const onDisk = () => readFile(file, "utf8");
		const cell = (row: number, column: number) => box.locator(`.cm-live-table [data-row="${row}"][data-column="${column}"]`);
		const range = box.locator(".cm-live-table-range");
		const choose = (label: string) => electronApp!.evaluate(({ Menu }, wanted) => {
			Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
				(globalThis as unknown as { __menu: string }).__menu = this.items.filter((item) => item.enabled).map((item) => item.label).join("|");
				this.items.find((item) => item.label === wanted && item.enabled)?.click();
				options?.callback?.();
			};
		}, label);
		const center = async (target: import("@playwright/test").Locator) => {
			const at = (await target.boundingBox())!;
			return { x: at.x + at.width / 2, y: at.y + at.height / 2 };
		};
		const dragTo = async (from: import("@playwright/test").Locator, to: import("@playwright/test").Locator) => {
			const start = await center(from);
			const end = await center(to);
			await loomPage.mouse.move(start.x, start.y);
			await loomPage.mouse.down();
			await loomPage.mouse.move(end.x, end.y, { steps: 8 });
			await loomPage.mouse.up();
		};
		await expect(box.locator(".cm-live-table")).toHaveCount(1);

		// A drag inside one cell is a text selection and picks nothing.
		const one = (await cell(2, 0).boundingBox())!;
		await loomPage.mouse.move(one.x + 8, one.y + one.height / 2);
		await loomPage.mouse.down();
		await loomPage.mouse.move(one.x + one.width - 8, one.y + one.height / 2, { steps: 6 });
		await loomPage.mouse.up();
		await expect(range).toHaveCount(0);

		// Dragged into another cell, the block from one to the other is framed, and the frame is that block's size.
		await dragTo(cell(2, 1), cell(3, 2));
		await expect(range).toHaveCount(1);
		const frame = (await range.boundingBox())!;
		const first = (await cell(2, 1).boundingBox())!;
		const last = (await cell(3, 2).boundingBox())!;
		expect(Math.abs(frame.x - first.x)).toBeLessThan(2);
		expect(Math.abs(frame.y - first.y)).toBeLessThan(2);
		expect(Math.abs(frame.x + frame.width - (last.x + last.width))).toBeLessThan(2);
		expect(Math.abs(frame.y + frame.height - (last.y + last.height))).toBeLessThan(2);
		// No caret is left in a cell, and the file is untouched.
		await expect(box.locator(".cm-live-table td:focus, .cm-live-table th:focus")).toHaveCount(0);
		await expect.poll(onDisk).toBe(original);
		// Dragging back the other way picks the same kind of block.
		await dragTo(cell(3, 2), cell(2, 1));
		const back = (await range.boundingBox())!;
		expect(Math.abs(back.width - frame.width)).toBeLessThan(2);

		// Alignment from the menu is set on every column of the block.
		await choose("Align right");
		await cell(2, 1).click({ button: "right" });
		await expect.poll(onDisk).toBe(original.replace("| :--- | ---: | :-: | --- |", "| :--- | ---: | ---: | --- |"));
		// The menu on a cell outside the block is for that cell's column alone, and drops the block.
		await dragTo(cell(1, 0), cell(2, 1));
		await choose("Align center");
		await cell(4, 3).click({ button: "right" });
		await expect(range).toHaveCount(0);
		await expect.poll(onDisk).toBe(original.replace("| :--- | ---: | :-: | --- |", "| :--- | ---: | ---: | :-: |"));

		// Rows and columns are added as many as the block covers, and deleted with it.
		await dragTo(cell(2, 0), cell(3, 1));
		await choose("Insert row above");
		await cell(2, 0).click({ button: "right" });
		await expect(box.locator(".cm-live-table tr")).toHaveCount(7);
		await dragTo(cell(2, 0), cell(3, 1));
		await choose("Delete row");
		await cell(2, 0).click({ button: "right" });
		await expect(box.locator(".cm-live-table tr")).toHaveCount(5);
		await dragTo(cell(1, 1), cell(1, 2));
		await choose("Insert column to the left");
		await cell(1, 1).click({ button: "right" });
		await expect(box.locator(".cm-live-table th")).toHaveCount(6);
		await dragTo(cell(1, 1), cell(1, 2));
		await choose("Delete column");
		await cell(1, 1).click({ button: "right" });
		await expect(box.locator(".cm-live-table th")).toHaveCount(4);
		await expect.poll(onDisk).toBe(original.replace("| :--- | ---: | :-: | --- |", "| :--- | ---: | ---: | :-: |"));
		// Taking every column at once is not offered.
		await dragTo(cell(1, 0), cell(2, 3));
		await choose("Delete column");
		await cell(1, 0).click({ button: "right" });
		expect(await electronApp!.evaluate(() => (globalThis as unknown as { __menu: string }).__menu)).not.toContain("Delete column");
		await expect.poll(onDisk).toBe(original.replace("| :--- | ---: | :-: | --- |", "| :--- | ---: | ---: | :-: |"));

		// Copying gives the block as a Markdown table of its own, with the header of those columns on top.
		await dragTo(cell(3, 1), cell(4, 2));
		await loomPage.keyboard.press("ControlOrMeta+c");
		const copied = await electronApp!.evaluate(({ clipboard }) => clipboard.readText());
		expect(copied).toBe("| 数量 | 备注 |\n| ---: | ---: |\n| 7 | 粉 |\n| 9 | 紫 |");
		await expect.poll(onDisk).toBe(original.replace("| :--- | ---: | :-: | --- |", "| :--- | ---: | ---: | :-: |"));

		// Delete empties the block's cells and nothing else. Undo brings them back in one step.
		await loomPage.keyboard.press("Delete");
		await expect.poll(onDisk).toBe(`上文\n\n| 名称 | 数量 | 备注 | 价格 |\n| :--- | ---: | ---: | :-: |\n| 苹果 | 3 | 红 | 5 |\n| 梨 | 12 | 黄 | 6 |\n| 桃 |  |  | 8 |\n| 李 |  |  | 4 |\n\n下文\n`);
		await expect(range).toHaveCount(0);
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(onDisk).toBe(original.replace("| :--- | ---: | :-: | --- |", "| :--- | ---: | ---: | :-: |"));

		// Pasting: the copied cells go in with the top left at the cell that is pasted on, to the right and down.
		const base = original.replace("| :--- | ---: | :-: | --- |", "| :--- | ---: | ---: | :-: |");
		await dragTo(cell(1, 0), cell(2, 1));
		await loomPage.keyboard.press("ControlOrMeta+c");
		await cell(3, 2).click();
		await loomPage.keyboard.press("ControlOrMeta+v");
		await expect.poll(onDisk).toBe(base.replace("| 桃 | 7 | 粉 | 8 |", "| 桃 | 7 | 苹果 | 3 |").replace("| 李 | 9 | 紫 | 4 |", "| 李 | 9 | 梨 | 12 |"));
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(onDisk).toBe(base);
		// Past the edge, the table grows: here by a column and a row.
		await cell(4, 3).click();
		await loomPage.keyboard.press("ControlOrMeta+v");
		await expect.poll(onDisk).toBe(`上文\n\n| 名称 | 数量 | 备注 | 价格 |  |\n| :--- | ---: | ---: | :-: | --- |\n| 苹果 | 3 | 红 | 5 |  |\n| 梨 | 12 | 黄 | 6 |  |\n| 桃 | 7 | 粉 | 8 |  |\n| 李 | 9 | 紫 | 苹果 | 3 |\n|  |  |  | 梨 | 12 |\n\n下文\n`);
		await expect(box.locator(".cm-live-table tr")).toHaveCount(6);
		await expect(cell(0, 4)).toBeVisible();
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(onDisk).toBe(base);
		await expect(box.locator(".cm-live-table tr")).toHaveCount(5);
		// Pasted on a block of cells, they go in from its top left.
		await dragTo(cell(3, 1), cell(4, 2));
		await loomPage.keyboard.press("ControlOrMeta+v");
		await expect.poll(onDisk).toBe(base.replace("| 桃 | 7 | 粉 | 8 |", "| 桃 | 苹果 | 3 | 8 |").replace("| 李 | 9 | 紫 | 4 |", "| 李 | 梨 | 12 | 4 |"));
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(onDisk).toBe(base);
		// Text from elsewhere, with tabs and line breaks, is cells too.
		await electronApp!.evaluate(({ clipboard }) => clipboard.writeText("a\tb\nc\td"));
		await cell(1, 0).click();
		await loomPage.keyboard.press("ControlOrMeta+v");
		await expect.poll(onDisk).toBe(base.replace("| 苹果 | 3 |", "| a | b |").replace("| 梨 | 12 |", "| c | d |"));
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(onDisk).toBe(base);
		// A single word pasted into a cell is text at the caret, not a cell.
		await electronApp!.evaluate(({ clipboard }) => clipboard.writeText("新"));
		await cell(1, 0).click();
		await loomPage.keyboard.press("ControlOrMeta+v");
		await expect.poll(onDisk).toBe(base.replace("| 苹果 |", "| 苹果新 |"));
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(onDisk).toBe(base);
		// A single word pasted over a block fills it.
		await dragTo(cell(1, 0), cell(2, 1));
		await loomPage.keyboard.press("ControlOrMeta+v");
		await expect.poll(onDisk).toBe(base.replace("| 苹果 | 3 |", "| 新 | 新 |").replace("| 梨 | 12 |", "| 新 | 新 |"));
		await loomPage.keyboard.press("ControlOrMeta+z");
		await expect.poll(onDisk).toBe(base);

		// Escape ends the pick and puts the caret back in the cell it began in.
		await dragTo(cell(2, 0), cell(3, 1));
		await expect(range).toHaveCount(1);
		await loomPage.keyboard.press("Escape");
		await expect(range).toHaveCount(0);
		await expect(cell(2, 0)).toBeFocused();
		// A click elsewhere ends it as well.
		await dragTo(cell(2, 0), cell(3, 1));
		await cell(4, 3).click();
		await expect(range).toHaveCount(0);
		// A drag that leaves the table picks as far as the edge it left from.
		await dragTo(cell(2, 0), box.locator(".cm-line").filter({ hasText: "下文" }));
		await expect(range).toHaveCount(1);
		const out = (await range.boundingBox())!;
		const bottom = (await cell(4, 0).boundingBox())!;
		expect(Math.abs(out.y + out.height - (bottom.y + bottom.height))).toBeLessThan(2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

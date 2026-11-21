import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { expect, test } from "./loom.ts";

async function libraryPath(page: Page): Promise<string> {
	const root = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(root).toBeTruthy();
	return (await root())!;
}

function row(page: Page, filename: string) {
	return page.locator(".library-sidebar .asset-row").filter({ hasText: filename });
}

async function recordDropMenus(app: ElectronApplication) {
	return app.evaluateHandle(({ Menu }) => {
		const state = { labels: [] as string[][], choice: "" };
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			state.labels.push(this.items.map((item) => item.label));
			this.items.find((item) => item.label === state.choice)?.click();
			options?.callback?.();
		};
		return state;
	});
}

async function nativeDropFixture(target: Locator) {
	const page = target.page();
	await page.evaluate(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.dataset.dropFixture = "";
		input.hidden = true;
		document.body.append(input);
	});
	const fileInput = page.locator("input[data-drop-fixture]");
	const drag = (type: "dragover" | "dragleave" | "drop", offset = 100) => target.evaluate((element, { type, offset }) => {
		const input = document.querySelector<HTMLInputElement>("input[data-drop-fixture]")!;
		const transfer = new DataTransfer();
		for (const file of input.files!) {
			if (!window.loom.pathForFile(file)) throw new Error("The file input did not provide a native path");
			transfer.items.add(file);
		}
		const bounds = element.getBoundingClientRect();
		return element.dispatchEvent(new DragEvent(type, {
			dataTransfer: transfer, clientX: bounds.left + offset, clientY: bounds.top + 10, bubbles: true, cancelable: true,
			relatedTarget: type === "dragleave" ? document.body : null,
		}));
	}, { type, offset });
	return { fileInput, drag };
}

test("dragging a library file inserts an undoable link where it lands in Markdown", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(loomPage);
	const file = join(root, "drop.md");
	const reference = "参考 (v1).txt";
	const original = "Before\n\n```text\nCode\n```\n\nAfter\n\n| Header |\n| --- |\n| Cell |\n";
	const link = "[[参考 (v1).txt]]";
	await writeFile(file, original);
	await writeFile(join(root, reference), "# Reference\n");
	await row(loomPage, "drop.md").click();
	const preview = await loomPage.evaluateHandle(() => {
		const original = DataTransfer.prototype.setDragImage;
		let geometry: { filename: string; gap: number } | undefined;
		DataTransfer.prototype.setDragImage = function (image, x, y) {
			const label = image.querySelector(".asset-drag-preview-label");
			if (label) {
				geometry = {
					filename: label.textContent ?? "",
					gap: label.getBoundingClientRect().top - image.getBoundingClientRect().top - y,
				};
				DataTransfer.prototype.setDragImage = original;
			}
			original.call(this, image, x, y);
		};
		return () => geometry;
	});
	const box = loomPage.getByRole("textbox", { name: "Edit drop.md" });
	const caret = loomPage.locator(".cm-dropCursor");
	const mouse = loomPage.mouse;
	const source = row(loomPage, reference);
	const beginDrag = async () => {
		const bounds = (await source.boundingBox())!;
		await mouse.move(bounds.x + 20, bounds.y + bounds.height / 2);
		await mouse.down();
	};

	await box.press("ControlOrMeta+End");
	const target = box.locator(".cm-line").filter({ hasText: /^Before$/ });
	const points = await target.evaluate((element) => {
		const range = document.createRange();
		return [1, 3].map((offset) => {
			range.setStart(element.firstChild!, offset);
			range.collapse(true);
			const { left, top, height } = range.getBoundingClientRect();
			return { x: left, y: top + height / 2 };
		});
	});
	await beginDrag();
	for (const { x, y } of points) {
		await mouse.move(x, y, { steps: 8 });
		await mouse.move(x + 0.25, y);
		await expect(caret).toBeVisible();
		await expect.poll(async () => Math.abs((await caret.boundingBox())!.x - x)).toBeLessThan(2);
	}
	expect(await preview.evaluate((geometry) => geometry())).toEqual({ filename: reference, gap: 24 });
	await preview.dispose();
	await mouse.up();
	await expect(caret).toHaveCount(0);
	await loomPage.keyboard.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe(original.replace("Before", `Bef ${link} ore`));
	await loomPage.keyboard.press("ControlOrMeta+z");
	await loomPage.keyboard.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe(original);

	await loomPage.getByRole("button", { name: "Source mode", exact: true }).click();
	await row(loomPage, reference).dragTo(box.locator(".cm-line").filter({ hasText: /^Code$/ }), {
		targetPosition: { x: 80, y: 10 },
	});
	await loomPage.keyboard.press("ControlOrMeta+s");
	const withCodeDrop = original.replace("```text", link + "\n\n```text");
	await expect.poll(() => readFile(file, "utf8")).toBe(withCodeDrop);

	await loomPage.getByRole("button", { name: "Source mode", exact: true }).click();
	const table = box.locator(".cm-live-table");
	const cell = (await table.locator("td").getByText("Cell", { exact: true }).boundingBox())!;
	await beginDrag();
	await mouse.move(cell.x + 10, cell.y + 10, { steps: 8 });
	await mouse.move(cell.x + 11, cell.y + 10);
	await expect(caret).toBeVisible();
	await expect.poll(async () => Math.abs((await caret.boundingBox())!.y - (await table.boundingBox())!.y)).toBeLessThan(5);
	await mouse.up();
	await expect(caret).toHaveCount(0);
	await loomPage.keyboard.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe(withCodeDrop.replace("| Header |", link + "\n\n| Header |"));
});

test("dragging onto or below a wiki link shows where the new link will be inserted", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(loomPage);
	const file = join(root, "drop.md");
	const original = "[[Untitled 3.canvas]]";
	await writeFile(file, original);
	await writeFile(join(root, "Untitled 3.canvas"), JSON.stringify({ nodes: [], edges: [] }));
	await writeFile(join(root, "reference.txt"), "Reference\n");
	await row(loomPage, "drop.md").click();
	const editor = loomPage.getByRole("textbox", { name: "Edit drop.md" });
	const link = editor.locator(".cm-live-wiki[data-asset-id]");
	await expect(link).toHaveText("Untitled 3.canvas");
	await expect(editor.locator(".cm-live-hidden").filter({ hasText: "]]" })).toHaveCount(1);
	const bounds = (await link.boundingBox())!;
	const source = (await row(loomPage, "reference.txt").boundingBox())!;
	const { mouse } = loomPage;
	const caret = loomPage.locator(".cm-dropCursor");
	const dragOver = async (x: number, y: number) => {
		await mouse.move(source.x + 20, source.y + source.height / 2);
		await mouse.down();
		await mouse.move(x, y, { steps: 8 });
		await mouse.move(x + 1, y);
		await expect(caret).toBeVisible();
		return (await caret.boundingBox())!;
	};
	const dropAndSave = async (expected: string) => {
		await mouse.up();
		await expect(caret).toHaveCount(0);
		await editor.press("ControlOrMeta+s");
		await expect.poll(() => readFile(file, "utf8")).toBe(expected);
	};
	const x = bounds.x + bounds.width / 2;
	const y = bounds.y + bounds.height / 2;
	const marker = await dragOver(x, y);
	expect(Math.abs(marker.x - (bounds.x + bounds.width))).toBeLessThan(2);
	expect(marker.y).toBeLessThan(y);
	expect(marker.y + marker.height).toBeGreaterThan(y);
	await dropAndSave(`${original} [[reference.txt]]`);

	await editor.press("ControlOrMeta+z");
	await editor.press("ControlOrMeta+End");
	const lastLine = editor.locator(".cm-line").last();
	const last = (await lastLine.boundingBox())!;
	const nextLine = await dragOver(x, last.y + last.height + 8);
	expect(Math.abs(nextLine.x - last.x)).toBeLessThan(2);
	expect(Math.abs(nextLine.y - (last.y + last.height))).toBeLessThan(3);
	await dropAndSave(`${original}\n[[reference.txt]]`);

	await editor.press("ControlOrMeta+z");
	await editor.press("ControlOrMeta+End");
	await editor.press("Enter");
	await expect(editor.locator(".cm-line")).toHaveCount(2);
	const blank = (await lastLine.boundingBox())!;
	const reusedLine = await dragOver(x, blank.y + blank.height + 8);
	expect(Math.abs(reusedLine.x - blank.x)).toBeLessThan(2);
	expect(reusedLine.y + reusedLine.height / 2).toBeLessThan(blank.y + blank.height);
	await dropAndSave(`${original}\n[[reference.txt]]`);
});

test("dropping native files imports them and inserts references only in edit modes", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(loomPage);
	const file = join(root, "drop.md");
	const external = join(dirname(root), "外部 (1).txt");
	const second = join(dirname(root), "hash#tag.txt");
	const readOnlyFile = join(dirname(root), "ignored.txt");
	await writeFile(file, "Drop here\n");
	await writeFile(external, "First file\n");
	await writeFile(second, "Second file\n");
	await writeFile(readOnlyFile, "This file is only dropped in reading mode.\n");
	await row(loomPage, "drop.md").click();
	const editor = loomPage.getByRole("textbox", { name: "Edit drop.md" });
	const caret = loomPage.locator(".cm-dropCursor");
	const target = editor.locator(".cm-line").filter({ hasText: /^Drop here$/ });
	const { fileInput, drag } = await nativeDropFixture(target);

	await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
	await expect(editor).toHaveAttribute("aria-readonly", "true");
	await fileInput.setInputFiles(readOnlyFile);
	expect(await drag("dragover")).toBe(false);
	await expect(caret).toHaveCount(0);
	expect(await drag("drop")).toBe(false);
	expect(await readFile(file, "utf8")).toBe("Drop here\n");
	await loomPage.getByRole("button", { name: "Edit mode", exact: true }).click();
	await expect(editor).toHaveAttribute("aria-readonly", "false");
	await fileInput.setInputFiles([external, second]);
	expect(await drag("dragover")).toBe(false);
	await expect(caret).toBeVisible();
	await drag("dragleave");
	await expect(caret).toHaveCount(0);
	expect(await drag("dragover")).toBe(false);
	await expect(caret).toBeVisible();
	// Drop coordinates can change before another dragover. Use the caret we last showed.
	expect(await drag("drop", 0)).toBe(false);
	await expect(caret).toHaveCount(0);
	await expect.poll(() => readFile(file, "utf8")).toBe(
		"Drop here [[Inbox/外部 (1).txt]] [hash#tag.txt](Inbox/hash%23tag.txt)\n",
	);
	expect(await readFile(join(root, "Inbox", "外部 (1).txt"), "utf8")).toBe("First file\n");
	expect(await readFile(join(root, "Inbox", "hash#tag.txt"), "utf8")).toBe("Second file\n");
	expect(await readdir(join(root, "Inbox"))).not.toContain("ignored.txt");
	expect(await readFile(external, "utf8")).toBe("First file\n");
	await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
	await expect(loomPage.locator(".cm-content [data-asset-id]")).toHaveCount(2);
	await loomPage.locator(".cm-content [data-asset-id]").filter({ hasText: "外部 (1).txt" }).click();
	await expect(loomPage.getByRole("tablist", { name: "Open files" }).getByRole("tab", { selected: true })).toHaveAccessibleName("外部 (1).txt");
});

test("a library media drop can insert a link or embed a standalone player", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(page);
	const note = join(root, "drop.md");
	const original = "Drop here\nNext line\n\n    ";
	await writeFile(note, original);
	await copyFile(new URL("../../core/tests/fixtures/media/clip.mp4", import.meta.url), join(root, "clip.mp4"));
	const menu = await recordDropMenus(electronApp!);
	await row(page, "drop.md").click();
	const editor = page.getByRole("textbox", { name: "Edit drop.md", exact: true });
	const target = editor.locator(".cm-line").first();
	const drop = () => row(page, "clip.mp4").dragTo(target, { targetPosition: { x: 100, y: 10 } });
	await menu.evaluate((state) => { state.choice = "Insert link"; });
	await drop();
	await expect.poll(() => readFile(note, "utf8")).toBe("Drop here [[clip.mp4]]\nNext line\n\n    ");
	await editor.press("ControlOrMeta+z");
	await editor.press("ControlOrMeta+s");
	await expect.poll(() => readFile(note, "utf8")).toBe(original);
	await menu.evaluate((state) => { state.choice = "Embed content"; });
	await drop();
	await expect.poll(() => readFile(note, "utf8")).toBe("Drop here\n\n![[clip.mp4]]\n\nNext line\n\n    ");
	await expect(editor.locator(".cm-wiki-embed video")).toBeVisible();
	await editor.press("ControlOrMeta+z");
	await editor.press("ControlOrMeta+s");
	await expect.poll(() => readFile(note, "utf8")).toBe(original);
	await row(page, "clip.mp4").dragTo(editor.locator(".cm-line").last());
	await expect.poll(() => readFile(note, "utf8")).toBe(`${original}\n![[clip.mp4]]`);
	await expect(editor.locator(".cm-wiki-embed video")).toBeVisible();
	const labels = ["Insert link", "Embed content"];
	expect(await menu.evaluate((state) => state.labels)).toEqual([labels, labels, labels]);
});

test("dropping a Markdown file can embed its rendered text", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(page);
	const note = join(root, "drop.md");
	await writeFile(note, "Drop here\n");
	await writeFile(join(root, "reference.md"), "# Referenced heading\n\nRendered **content**.");
	const menu = await recordDropMenus(electronApp!);
	await menu.evaluate((state) => { state.choice = "Embed content"; });
	await row(page, "drop.md").click();
	const editor = page.getByRole("textbox", { name: "Edit drop.md", exact: true });
	await row(page, "reference.md").dragTo(editor.locator(".cm-line").first(), { targetPosition: { x: 100, y: 10 } });
	await expect.poll(() => readFile(note, "utf8")).toBe("Drop here\n\n![[reference.md]]\n");
	await expect(editor.getByRole("heading", { name: "Referenced heading" })).toBeVisible();
	await expect(editor.locator(".markdown-note-embed strong")).toHaveText("content");
});

test("canceling a native media drop skips import and embedding preserves unsupported file links", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(page);
	const note = join(root, "drop.md");
	const image = join(dirname(root), "still#1.png");
	const text = join(dirname(root), "reference.txt");
	await writeFile(note, "Drop here\n");
	await copyFile(new URL("../../core/tests/fixtures/media/still.png", import.meta.url), image);
	await writeFile(text, "Reference\n");
	const menu = await recordDropMenus(electronApp!);
	await row(page, "drop.md").click();
	const editor = page.getByRole("textbox", { name: "Edit drop.md", exact: true });
	const { fileInput, drag } = await nativeDropFixture(editor.locator(".cm-line").first());
	await fileInput.setInputFiles([image, text]);
	await drag("drop");
	await expect.poll(() => menu.evaluate((state) => state.labels.length)).toBe(1);
	await expect(readFile(join(root, "Inbox", "still#1.png"))).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(note, "utf8")).toBe("Drop here\n");

	await menu.evaluate((state) => { state.choice = "Embed content"; });
	await drag("drop");
	await expect.poll(() => readFile(note, "utf8")).toBe("Drop here ![still#1.png](Inbox/still%231.png) [[Inbox/reference.txt]]\n");
	await expect(editor.locator("img.cm-live-image")).toBeVisible();
});

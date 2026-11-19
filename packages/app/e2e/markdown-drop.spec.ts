import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./loom.ts";

async function libraryPath(page: Page): Promise<string> {
	const root = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(root).toBeTruthy();
	return (await root())!;
}

function row(page: Page, filename: string) {
	return page.locator(".library-sidebar .asset-row").filter({ hasText: filename });
}

test("dragging a library file inserts an undoable link where it lands in Markdown", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(loomPage);
	const file = join(root, "drop.md");
	const reference = "参考 (v1).md";
	const original = "Before\n\n```text\nCode\n```\n\nAfter\n\n| Header |\n| --- |\n| Cell |\n";
	const link = "[[参考 (v1).md]]";
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
	await loomPage.evaluate(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.dataset.dropFixture = "";
		input.hidden = true;
		document.body.append(input);
	});
	const fileInput = loomPage.locator("input[data-drop-fixture]");
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
	await expect(loomPage.getByRole("tablist", { name: "Open files" }).getByRole("tab", { selected: true })).toHaveText("外部 (1).txt");
});

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { expect, test } from "./loom.ts";

async function libraryPath(page: Page): Promise<string> {
	const root = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(root).toBeTruthy();
	return (await root())!;
}

function openNote(page: Page) {
	return page.locator(".library-sidebar .asset-row").filter({ hasText: "commands.md" }).click();
}

test("slash commands search in Chinese, respect IME Enter and create an editable table", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const file = join(await libraryPath(loomPage), "commands.md");
	await writeFile(file, "Before\n\nAfter\n");
	await openNote(loomPage);
	const box = loomPage.getByRole("textbox", { name: "Edit commands.md" });
	const menu = loomPage.locator(".cm-markdown-insert").getByRole("listbox");
	await box.press("ControlOrMeta+End");
	await box.press("ArrowUp");
	await box.press("ArrowUp");
	await loomPage.keyboard.insertText("/");
	const firstOption = menu.getByRole("option", { name: "Heading 1", exact: true });
	await expect(firstOption).toHaveAttribute("aria-selected", "true");
	await expect(firstOption).toHaveCSS("padding", "6px 8px");
	await expect(menu.getByRole("option").locator("svg.markdown-insert-icon[aria-hidden=true]")).toHaveCount(13);
	await box.press("ArrowUp");
	const lastOption = menu.getByRole("option", { name: "Link to a library file", exact: true });
	await expect(lastOption).toHaveAttribute("aria-selected", "true");
	await expect(lastOption).toBeInViewport({ ratio: 0.95 });
	await box.press("ArrowDown");
	await box.press("ArrowDown");
	await expect(menu.getByRole("option", { name: "Heading 2", exact: true })).toHaveAttribute("aria-selected", "true");
	await loomPage.keyboard.insertText("表格");
	await expect(menu.getByRole("option", { name: "Table", exact: true })).toHaveAttribute("aria-selected", "true");
	await box.dispatchEvent("keydown", { key: "Enter", isComposing: true });
	await expect(menu).toBeVisible();
	await box.press("Enter");

	const firstCell = box.locator(".cm-live-table th[contenteditable=plaintext-only]").first();
	await expect(firstCell).toBeFocused();
	await loomPage.keyboard.insertText("Name");
	await loomPage.keyboard.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe("Before\n\n| Name |  |\n| --- | --- |\n|  |  |\n\nAfter\n");
});

test("the Insert button and slash menu create undoable, portable Markdown", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(loomPage);
	const file = join(root, "commands.md");
	const reference = join(root, "参考 (v1).md");
	await writeFile(file, "Existing paragraph\n");
	await writeFile(reference, "# Reference\n");
	await openNote(loomPage);
	const box = loomPage.getByRole("textbox", { name: "Edit commands.md" });
	const button = loomPage.getByRole("button", { name: "Insert", exact: true });
	const menu = loomPage.locator(".cm-markdown-insert").getByRole("listbox");
	await box.press("ArrowRight");
	await button.click();
	await expect(menu).toBeVisible();
	await box.press("Escape");
	await expect(menu).toBeHidden();
	await box.press("ControlOrMeta+s");
	expect(await readFile(file, "utf8")).toBe("Existing paragraph\n");

	await button.click();
	await menu.getByRole("option", { name: "Heading 2", exact: true }).click();
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe("Existing paragraph\n\n## \n");
	await box.press("ControlOrMeta+z");
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe("Existing paragraph\n");

	await box.press("ControlOrMeta+End");
	await loomPage.keyboard.insertText("/link");
	await menu.getByRole("option", { name: "Link to a library file", exact: true }).click();
	const picker = loomPage.getByRole("dialog", { name: "Link to a library file", exact: true });
	const search = picker.getByRole("combobox", { name: "Search library files" });
	await expect(search).toBeFocused();
	await search.fill("参考");
	await expect(picker.getByRole("option", { name: "参考 (v1).md", exact: true })).toBeVisible();
	await search.press("Enter");
	await expect(picker).toHaveCount(0);
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe("Existing paragraph\n\n[[参考 (v1).md]]");
	await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
	await expect(button).toHaveCount(0);
	const link = box.locator("[data-asset-id]").filter({ hasText: "参考 (v1).md" });
	await link.click();
	await expect(loomPage.getByRole("textbox", { name: "Edit 参考 (v1).md" })).toBeVisible();
});

test("wiki link completion filters files and replaces only the link target", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(loomPage);
	const file = join(root, "commands.md");
	const first = "Alpha/参考.md";
	const second = "Beta/参考.md";
	await mkdir(join(root, "Alpha"));
	await mkdir(join(root, "Beta"));
	await writeFile(join(root, first), "# First");
	await writeFile(join(root, second), "# Second");
	await writeFile(join(root, "unrelated.md"), "# Unrelated");
	await writeFile(file, ["后缀", "", `[[${second}#标题|别名]]`, "", "```", "", "```"].join("\n"));
	await openNote(loomPage);

	const box = loomPage.getByRole("textbox", { name: "Edit commands.md" });
	const menu = loomPage.locator(".cm-markdown-insert").getByRole("listbox");
	await box.press("ControlOrMeta+Home");
	await loomPage.keyboard.insertText("[[");
	await expect(menu.getByRole("option", { name: "unrelated.md" })).toBeVisible();
	await loomPage.getByRole("button", { name: "Insert", exact: true }).click();
	await expect(menu.getByRole("option", { name: "Heading 1", exact: true })).toBeVisible();
	await box.press("Escape");
	await box.press("Home");
	await box.press("ArrowRight");
	await box.press("ArrowRight");
	await expect(menu.getByRole("option", { name: "unrelated.md" })).toBeVisible();
	await loomPage.keyboard.insertText("参考");
	await expect(menu.getByRole("option")).toHaveCount(2);
	const activeOption = menu.locator('[aria-selected="true"]');
	const initial = await activeOption.innerText();
	await box.press("ArrowDown");
	await expect(activeOption).not.toHaveText(initial);
	const chosen = await activeOption.innerText();
	expect([first, second]).toContain(chosen);
	await box.dispatchEvent("keydown", { key: "Enter", isComposing: true });
	await expect(menu).toBeVisible();
	await box.press("Enter");
	await loomPage.keyboard.insertText(" 后续");
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toContain(`[[${chosen}]] 后续后缀`);

	const existing = box.locator(".cm-line").filter({ hasText: "别名" });
	await existing.click({ modifiers: ["Alt"] });
	await box.press("Home");
	await box.press("ArrowRight");
	await box.press("ArrowRight");
	// Give CodeMirror's deferred completion query time to open if moving the caret started one.
	await expect(menu.waitFor({ state: "visible", timeout: 350 })).rejects.toThrow(/Timeout/);
	await loomPage.keyboard.insertText("Alpha");
	await menu.getByRole("option", { name: first }).click();
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toContain(`[[${first}#标题|别名]]`);

	await box.press("ControlOrMeta+End");
	await box.press("ArrowUp");
	await loomPage.keyboard.insertText("[[");
	await expect(box.locator(".cm-live-codeblock").filter({ hasText: "[[" })).toBeVisible();
	await expect(menu).toBeHidden();
});

test("wiki embed completion fills empty brackets and suggests files", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(loomPage);
	const file = join(root, "commands.md");
	const image = "Images/cover.png";
	await mkdir(join(root, "Images"));
	await copyFile(new URL("../../core/tests/fixtures/media/still.png", import.meta.url), join(root, image));
	await writeFile(join(root, "reference.md"), "# Reference");
	await writeFile(file, "![[]]\n\n");
	await openNote(loomPage);

	const box = loomPage.getByRole("textbox", { name: "Edit commands.md" });
	const menu = loomPage.locator(".cm-markdown-insert").getByRole("listbox");
	const options = menu.getByRole("option");
	await box.press("ControlOrMeta+Home");
	for (const _ of "![[") await box.press("ArrowRight");
	await expect(options).toHaveText([image, "reference.md"]);
	await loomPage.keyboard.insertText("cover");
	await box.press("Enter");
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe(`![[${image}]]\n\n`);

	await box.press("ControlOrMeta+End");
	await loomPage.keyboard.insertText("![[");
	await expect(options).toHaveText([image, "reference.md"]);
	await loomPage.keyboard.insertText("cover");
	await menu.getByRole("option", { name: image, exact: true }).click();
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe(`![[${image}]]\n\n![[${image}]]`);

	await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
	const embeds = box.locator("img.cm-live-image");
	await expect(embeds).toHaveCount(2);
	await expect.poll(() => embeds.evaluateAll((images: HTMLImageElement[]) => images.every((image) => image.naturalWidth > 0))).toBe(true);
});

test("wiki embeds play media, open files and reveal only the chosen source", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(page);
	const file = join(root, "commands.md");
	for (const name of ["clip.mp4", "still.png"]) {
		await copyFile(new URL(`../../core/tests/fixtures/media/${name}`, import.meta.url), join(root, name));
	}
	const wave = Buffer.alloc(44 + 16_000);
	wave.write("RIFF", 0);
	wave.writeUInt32LE(wave.length - 8, 4);
	wave.write("WAVEfmt ", 8);
	wave.writeUInt32LE(16, 16);
	wave.writeUInt16LE(1, 20);
	wave.writeUInt16LE(1, 22);
	wave.writeUInt32LE(8_000, 24);
	wave.writeUInt32LE(16_000, 28);
	wave.writeUInt16LE(2, 32);
	wave.writeUInt16LE(16, 34);
	wave.write("data", 36);
	wave.writeUInt32LE(wave.length - 44, 40);
	await writeFile(join(root, "sound.wav"), wave);
	await writeFile(join(root, "reference.md"), "# Reference");
	const source = [
		"![[clip.mp4]]", "![[sound.wav]]", "![[still.png|First picture]]", "![[still.png|Second picture]]",
		"Inline ![[clip.mp4]] stays compact.", "| Media |\n| --- |\n| Clip ![[clip.mp4]] |\n| ![[still.png]] |", "![[reference.md]]",
	].join("\n\n");
	await writeFile(file, source);
	await openNote(page);

	const editor = page.getByRole("textbox", { name: "Edit commands.md", exact: true });
	const embeds = editor.locator(".cm-wiki-embed");
	await expect(embeds).toHaveCount(6);
	for (const kind of ["video", "audio"]) {
		const player = embeds.locator(kind);
		await expect(player).toHaveCount(1);
		await expect(player).toHaveAttribute("controls", "");
		await player.evaluate(async (element: HTMLMediaElement) => {
			await element.play();
			element.pause();
		});
		await expect(player).toBeVisible();
	}
	await expect.poll(() => embeds.locator("video").evaluate((video: HTMLVideoElement) => {
		const bounds = video.getBoundingClientRect();
		return Math.abs(bounds.width / bounds.height - video.videoWidth / video.videoHeight);
	})).toBeLessThan(0.01);
	const audioOffsets = await embeds.locator("audio").evaluate((audio: HTMLAudioElement) => {
		const block = audio.parentElement!;
		const measure = () => {
			const bounds = block.getBoundingClientRect();
			return [...block.children].map((child) => {
				const item = child.getBoundingClientRect();
				return Math.abs(item.left - bounds.left - (bounds.right - item.right));
			});
		};
		const full = measure();
		block.style.maxInlineSize = "180px";
		const narrow = measure();
		block.style.removeProperty("max-inline-size");
		return [...full, ...narrow];
	});
	expect(Math.max(...audioOffsets)).toBeLessThan(1);
	await expect(editor.locator(".cm-line").filter({ hasText: "Inline" }).locator(".markdown-embed-file")).toContainText("clip.mp4");

	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			this.items.find((item) => item.label === "Edit embed syntax" && item.enabled)?.click();
			options?.callback?.();
		};
	});
	const picture = (alt: string) => editor.getByRole("img", { name: alt, exact: true });
	const pictureLink = picture("First picture").locator("xpath=following-sibling::a");
	await expect(pictureLink).toHaveText("First picture");
	await expect(pictureLink).toBeVisible();
	const media = embeds.locator(".markdown-embed-media");
	await expect(media).toHaveCount(4);
	await expect.poll(() => media.evaluateAll((blocks) => Math.max(...blocks.map((block) => {
		const preview = block.firstElementChild!.getBoundingClientRect();
		const link = block.lastElementChild!.getBoundingClientRect();
		return Math.abs(preview.left + preview.width / 2 - (link.left + link.width / 2));
	})))).toBeLessThan(1);
	await expect(pictureLink).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await pictureLink.hover();
	await expect(pictureLink).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await picture("First picture").click();
	await expect(picture("First picture")).toBeVisible();
	await picture("Second picture").click({ button: "right" });
	await expect(editor).toContainText("![[still.png|Second picture]]");
	await expect(picture("Second picture")).toHaveCount(0);
	await expect(picture("First picture")).toHaveCount(1);
	await editor.press("Escape");
	await expect(picture("Second picture")).toBeVisible();
	await picture("Second picture").press("Shift+F10");
	await expect(editor).toContainText("![[still.png|Second picture]]");
	await editor.press("ControlOrMeta+End");
	await expect(picture("Second picture")).toBeVisible();

	const cell = editor.locator(".cm-live-table td").first();
	const cellEmbed = cell.locator(".markdown-embed-file");
	await expect(cellEmbed).toContainText("clip.mp4");
	await cellEmbed.click({ button: "right" });
	await expect(cell).toHaveText("Clip ![[clip.mp4]]");
	await expect(cell).toBeFocused();
	expect(await cell.evaluate((element) => element.ownerDocument.getSelection()?.anchorOffset)).toBe("Clip ![[".length);
	await cell.press("Escape");
	await expect(cellEmbed).toBeVisible();
	const tablePicture = picture("still.png");
	await tablePicture.click();
	await expect(tablePicture).toBeVisible();
	await tablePicture.click({ button: "right" });
	const imageCell = editor.locator(".cm-live-table td").last();
	await expect(imageCell).toHaveText("![[still.png]]");
	await imageCell.press("Escape");
	await expect(tablePicture).toBeVisible();
	expect(await readFile(file, "utf8")).toBe(source);

	await pictureLink.click();
	const originalImage = page.locator(".image-preview").getByRole("img", { name: "still.png" });
	await expect(originalImage).toBeVisible();
	await openNote(page);
	await editor.locator(".markdown-embed-file").filter({ hasText: "reference.md" }).click();
	const reference = page.getByRole("textbox", { name: "Edit reference.md", exact: true });
	await expect(reference).toBeVisible();

	await openNote(page);
	await page.getByRole("button", { name: "Reading mode", exact: true }).click();
	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			if (!this.items.find((item) => item.label === "Edit embed syntax")?.enabled) {
				this.items.find((item) => item.label === "Open original file")?.click();
			}
			options?.callback?.();
		};
	});
	await picture("First picture").click();
	await expect(picture("First picture")).toBeVisible();
	await picture("First picture").click({ button: "right" });
	await expect(originalImage).toBeVisible();
});

test("backspacing an existing wiki target reopens file completion", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(loomPage);
	const file = join(root, "commands.md");
	await writeFile(file, "[[zzz]]\n");
	await writeFile(join(root, "reference.md"), "# Reference\n");
	await openNote(loomPage);

	const box = loomPage.getByRole("textbox", { name: "Edit commands.md" });
	const menu = loomPage.locator(".cm-markdown-insert").getByRole("listbox");
	await box.press("ControlOrMeta+Home");
	await box.press("End");
	await box.press("ArrowLeft");
	await box.press("ArrowLeft");
	for (const _ of "zzz") await box.press("Shift+ArrowLeft");
	await expect(menu).toBeHidden();
	await box.press("Backspace");
	const reference = menu.getByRole("option", { name: "reference.md", exact: true });
	await expect(reference).toBeVisible();
	await reference.click();
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe("[[reference.md]]\n");
});

test("deleting a slash query reopens command completion", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	await writeFile(join(await libraryPath(loomPage), "commands.md"), "/tablezz\n\nParagraph\n");
	await openNote(loomPage);

	const box = loomPage.getByRole("textbox", { name: "Edit commands.md" });
	const menu = loomPage.locator(".cm-markdown-insert").getByRole("listbox");
	await box.press("ControlOrMeta+Home");
	await box.press("End");
	await expect(menu).toBeHidden();
	await box.press("Backspace");
	await box.press("Backspace");
	await expect(menu.getByRole("option", { name: "Table", exact: true })).toBeVisible();

	for (const _ of "table") await box.press("Shift+ArrowLeft");
	await expect(menu).toBeHidden();
	await box.press("Delete");
	await expect(menu.getByRole("option", { name: "Heading 1", exact: true })).toBeVisible();

	await box.press("ControlOrMeta+End");
	await box.press("ArrowUp");
	await box.press("End");
	await box.press("Backspace");
	await expect(box.locator(".cm-line").filter({ hasText: /^Paragrap$/ })).toBeVisible();
	await expect(menu).toBeHidden();
});

import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveMediaBinary } from "../../core/src/media/binaries.ts";
import type { CanvasDocument } from "../src/shared/canvas.ts";
import { expect, test } from "./loom.ts";

const still = new URL("../../core/tests/fixtures/media/still.png", import.meta.url);
const readBoard = async (path: string) => JSON.parse(await readFile(path, "utf8")) as CanvasDocument;

test("a library canvas saves cards, groups and connections, and follows references by asset ID", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	await expect.poll(async () => (await snapshot()).rootPath).toBeTruthy();
	const root = (await snapshot()).rootPath!;
	await copyFile(still, join(root, "参考.png"));
	await expect.poll(async () => (await snapshot()).assets.length).toBe(1);
	const reference = (await snapshot()).assets[0]!;
	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			this.items.find((item) => item.enabled && (item.label === "New Canvas" || item.label === "Group"))?.click();
			options?.callback?.();
		};
	});

	const sidebar = page.locator(".library-sidebar");
	const blank = sidebar.locator(".asset-list");
	const bounds = (await blank.boundingBox())!;
	await blank.click({ button: "right", position: { x: bounds.width / 2, y: bounds.height - 10 } });
	const rename = sidebar.locator(".rename-editor input");
	await expect(rename).toBeFocused();
	await rename.fill("分镜");
	await rename.press("Enter");
	const tab = page.getByRole("tab", { name: "分镜.canvas", exact: true });
	await expect(tab).toHaveAttribute("aria-selected", "true");

	const board = page.getByRole("region", { name: "Canvas 分镜.canvas" });
	await board.getByRole("button", { name: "Text", exact: true }).click();
	await board.getByRole("textbox", { name: "Markdown text" }).fill("## 开场");
	await board.getByRole("button", { name: "Done", exact: true }).click();
	await expect(board.getByRole("heading", { name: "开场" })).toBeVisible();

	const surface = board.locator(".canvas-surface");
	await sidebar.locator(".asset-row").filter({ hasText: "参考.png" }).dragTo(surface, { targetPosition: { x: 58, y: 45 } });
	const fileCard = board.locator(".canvas-card.type-file");
	await expect(fileCard).toHaveCount(1);
	const openPreview = fileCard.getByRole("button", { name: "Open preview 参考.png" });
	const preview = page.getByRole("dialog", { name: "File preview" });
	await openPreview.click();
	await expect(fileCard).toHaveClass(/selected/);
	await expect(preview).toHaveCount(0);

	const before = (await fileCard.boundingBox())!;
	const thumbnail = (await openPreview.boundingBox())!;
	const x = thumbnail.x + thumbnail.width / 2, y = thumbnail.y + thumbnail.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 20, y + 16, { steps: 4 });
	await page.mouse.up();
	await expect.poll(async () => (await fileCard.boundingBox())!.x).toBeGreaterThan(before.x);
	await expect(preview).toHaveCount(0);

	await openPreview.dblclick();
	await expect(preview.locator("img")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(preview).toHaveCount(0);
	await openPreview.press("Enter");
	await expect(preview.locator("img")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(preview).toHaveCount(0);

	const fileHandle = fileCard.locator(".canvas-handle");
	const textHandle = board.locator(".type-text .canvas-handle");
	await fileHandle.click();
	await textHandle.click({ modifiers: ["Shift"] });
	await expect(board.locator(".canvas-card.selected")).toHaveCount(2);
	await fileHandle.click({ button: "right" });
	await board.getByRole("textbox", { name: "Group title" }).fill("素材");
	await board.getByRole("button", { name: "Done", exact: true }).click();
	await fileHandle.click();
	await textHandle.click({ modifiers: ["Shift"] });
	await board.getByRole("button", { name: "Connect", exact: true }).click();
	await board.getByRole("textbox", { name: "Connection label" }).fill("接演示");
	await expect(board.locator(".canvas-edge-label")).toHaveText("接演示");
	await board.getByRole("button", { name: "Undo", exact: true }).click();
	await expect(board.locator(".canvas-edge-label")).toHaveText("↗");
	await board.getByRole("button", { name: "Redo", exact: true }).click();
	await expect(board.locator(".canvas-edge-label")).toHaveText("接演示");

	const path = join(root, "分镜.canvas");
	await expect.poll(async () => (await readBoard(path)).edges[0]?.label).toBe("接演示");
	const saved = await readBoard(path);
	expect(saved.nodes.find((node) => node.type === "file")).toMatchObject({
		file: "参考.png", loom: { assetId: reference.assetId },
	});
	const group = saved.nodes.find((node) => node.type === "group")!;
	expect(group.label).toBe("素材");
	const groupBounds = (await board.locator(".canvas-card.type-group").boundingBox())!;
	for (const card of [fileCard, board.locator(".canvas-card.type-text")]) {
		const bounds = (await card.boundingBox())!;
		expect(groupBounds.x).toBeLessThan(bounds.x);
		expect(groupBounds.y).toBeLessThan(bounds.y);
		expect(groupBounds.x + groupBounds.width).toBeGreaterThan(bounds.x + bounds.width);
		expect(groupBounds.y + groupBounds.height).toBeGreaterThan(bounds.y + bounds.height);
	}
	expect((await readdir(root)).sort()).toEqual([".loom", "参考.png", "分镜.canvas"].sort());

	await page.getByRole("button", { name: "Close 分镜.canvas" }).click();
	await sidebar.locator(".asset-row").filter({ hasText: "分镜.canvas" }).click();
	await expect(board.getByRole("heading", { name: "开场" })).toBeVisible();
	await expect(board.locator(".canvas-edge-label")).toHaveText("接演示");

	const fileBefore = (await readBoard(path)).nodes.find((node) => node.type === "file")!;
	const readImageRatio = () => fileCard.locator(".media-thumbnail img").evaluate((image: HTMLImageElement) => image.naturalWidth / image.naturalHeight);
	await expect.poll(readImageRatio).toBeGreaterThan(0);
	const imageRatio = await readImageRatio();
	await expect.poll(async () => {
		const { width, height } = (await fileCard.boundingBox())!;
		return width / height;
	}).toBeCloseTo(imageRatio);
	await fileCard.locator(".canvas-handle").press("ArrowRight");
	await fileCard.locator(".canvas-resize").press("ArrowDown");
	await expect.poll(async () => (await readBoard(path)).nodes.find((node) => node.type === "file")?.width).toBe(fileBefore.width + 8);
	const fileAfter = (await readBoard(path)).nodes.find((node) => node.type === "file")!;
	expect(fileAfter.x).toBe(fileBefore.x + 8);
	expect(fileAfter.height).toBe(Math.ceil(fileAfter.width / imageRatio));
	await page.evaluate((id) => window.loom.renameAsset(id, "参考改名"), reference.assetId);
	await expect(fileCard.getByRole("button", { name: "Open preview 参考改名.png" })).toBeVisible();
	await unlink(join(root, "参考改名.png"));
	await expect(fileCard.getByText("Missing asset", { exact: true })).toBeVisible();
	await expect(board.locator(".canvas-edge-label")).toHaveText("接演示");
});

test("canvas image and video frames follow the media aspect ratio when zoomed and resized", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const rootPath = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(rootPath).toBeTruthy();
	const root = (await rootPath())!;
	const media = [
		{ file: "still.png", ratio: 127 / 66 }, // Display ratio accounts for the PNG's non-square pixels.
		{ file: "clip.mp4", ratio: 480 / 360 },
	];
	await Promise.all(media.map(({ file }) => copyFile(new URL(file, still), join(root, file))));
	await writeFile(join(root, "Media.canvas"), JSON.stringify({
		nodes: media.map(({ file }, index) => ({ id: file, type: "file", file, x: index * 270, y: 0, width: 244, height: 172 })),
		edges: [],
	} satisfies CanvasDocument));
	await page.locator(".library-sidebar .asset-row").filter({ hasText: "Media.canvas" }).click();
	const board = page.getByRole("region", { name: "Canvas Media.canvas" });
	const cardFor = (file: string) => board.locator(".canvas-card").filter({ hasText: file });
	const frameRatio = async (file: string) => {
		const { width, height } = (await cardFor(file).boundingBox())!;
		return width / height;
	};
	for (const { file, ratio } of media) {
		const card = cardFor(file);
		const preview = card.locator(".media-thumbnail img");
		await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth / image.naturalHeight)).toBeCloseTo(ratio);
		await expect.poll(() => frameRatio(file)).toBeCloseTo(ratio);
		await expect(preview).toHaveCSS("object-fit", "contain");
		await expect(card.locator(".canvas-card-frame")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		const bounds = (await card.boundingBox())!;
		const title = (await card.locator(".canvas-card-header").boundingBox())!;
		expect(title.y + title.height).toBeCloseTo(bounds.y);
		expect(await preview.evaluate((image) => {
			const frame = image.closest(".canvas-card-frame")!;
			return { widthGap: frame.clientWidth - image.clientWidth, heightGap: frame.clientHeight - image.clientHeight };
		})).toEqual({ widthGap: 0, heightGap: 0 });
	}

	const video = cardFor("clip.mp4");
	const beforeZoom = (await video.boundingBox())!;
	await board.getByRole("button", { name: "Zoom in" }).click();
	const zoomed = (await video.boundingBox())!;
	expect(zoomed.width).toBeCloseTo(beforeZoom.width * 1.25);
	expect(zoomed.height).toBeCloseTo(beforeZoom.height * 1.25);
	for (const { file, ratio } of media) expect(await frameRatio(file)).toBeCloseTo(ratio);
	await board.getByRole("button", { name: "Fit view" }).click();

	await video.locator(".canvas-handle").click();
	const beforeResize = (await video.boundingBox())!;
	const handle = (await video.locator(".canvas-resize").boundingBox())!;
	await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
	await page.mouse.down();
	await page.mouse.move(handle.x + handle.width / 2 + 45, handle.y + handle.height / 2 + 12, { steps: 4 });
	await expect.poll(async () => (await video.boundingBox())!.width).toBeGreaterThan(beforeResize.width);
	expect(await frameRatio("clip.mp4")).toBeCloseTo(4 / 3);
	await page.mouse.up();
	expect(await frameRatio("clip.mp4")).toBeCloseTo(4 / 3);
	await expect.poll(async () => (await readBoard(join(root, "Media.canvas"))).nodes[1]?.width).toBeGreaterThan(244);
});

test("canvas video and audio play inline and resume after switching cards or tabs", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	test.setTimeout(60_000);
	const rootPath = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(rootPath).toBeTruthy();
	const root = (await rootPath())!;
	await promisify(execFile)(resolveMediaBinary("ffmpeg"), [
		"-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10", "-f", "lavfi", "-i", "aevalsrc=0.06*(1+sin(0.7*PI*t))*sin(2*PI*440*t):s=8000",
		"-map", "0:v", "-t", "60", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "Video.mp4"),
		"-map", "1:a", "-t", "60", "-c:a", "pcm_s16le", join(root, "Audio.wav"),
	], { windowsHide: true });
	await writeFile(join(root, "Other.md"), "# Other tab");
	await writeFile(join(root, "Playback.canvas"), JSON.stringify({
		nodes: [
			{ id: "video", type: "file", file: "Video.mp4", x: 0, y: 0, width: 244, height: 172 },
			{ id: "audio", type: "file", file: "Audio.wav", x: 280, y: 0, width: 244, height: 72 },
		],
		edges: [],
	} satisfies CanvasDocument));
	const sidebar = page.locator(".library-sidebar");
	await sidebar.locator(".asset-row").filter({ hasText: "Playback.canvas" }).click();
	const board = page.getByRole("region", { name: "Canvas Playback.canvas" });
	const videoCard = board.locator("[data-node-id=video]");
	const audioCard = board.locator("[data-node-id=audio]");
	const video = videoCard.locator("video");
	const audio = audioCard.locator("audio");
	const videoState = () => video.evaluate((element: HTMLVideoElement) => ({ paused: element.paused, time: element.currentTime }));
	const audioState = () => audio.evaluate((element: HTMLAudioElement) => ({ paused: element.paused, time: element.currentTime }));
	const videoPlay = videoCard.getByRole("button", { name: "Play Video.mp4", exact: true });
	const audioPlay = audioCard.getByRole("button", { name: "Play Audio.wav", exact: true });
	await expect(videoPlay).not.toHaveAttribute("data-tooltip", /.+/);
	await expect(audioPlay).not.toHaveAttribute("data-tooltip", /.+/);
	const waveform = audioCard.locator(".canvas-waveform");
	await expect(waveform).toBeVisible();
	const audioTime = audioCard.locator(".canvas-player-time");
	const audioMute = audioCard.getByRole("button", { name: "Mute", exact: true });
	const audioVolume = audioCard.getByRole("slider", { name: "Volume" });
	await expect(audioTime).toHaveText("0:00 / 1:00");
	await expect(audioPlay.locator("circle")).toHaveCSS("fill", await videoPlay.locator("circle").evaluate((disc) => getComputedStyle(disc).fill));
	await expect(audioPlay).toHaveCSS("width", "20px");
	await expect(audioPlay).toHaveCSS("height", "20px");
	await expect(audioVolume).toHaveCSS("--canvas-track-height", "4px");
	const waveBounds = (await waveform.boundingBox())!;
	const playBounds = (await audioPlay.boundingBox())!;
	const timeBounds = (await audioTime.boundingBox())!;
	const muteBounds = (await audioMute.boundingBox())!;
	const volumeBounds = (await audioVolume.boundingBox())!;
	expect(waveBounds.y + waveBounds.height).toBeLessThan(playBounds.y);
	expect(playBounds.x + playBounds.width).toBeLessThan(timeBounds.x);
	expect(timeBounds.x + timeBounds.width).toBeLessThan(muteBounds.x);
	expect(muteBounds.x + muteBounds.width).toBeLessThan(volumeBounds.x);
	expect(volumeBounds.x + volumeBounds.width).toBeCloseTo(waveBounds.x + waveBounds.width);
	const waveBars = waveform.locator("span");
	await expect(waveBars.first()).toHaveCSS("border-radius", "0px");
	const waveHeights = await waveBars.evaluateAll((bars) => bars.map((bar) => bar.getBoundingClientRect().height));
	expect(new Set(waveHeights).size).toBeGreaterThan(1);

	await videoCard.hover();
	expect(await videoState()).toEqual({ paused: true, time: 0 });
	await videoPlay.click();
	await expect.poll(async () => (await videoState()).time).toBeGreaterThan(0);
	await expect(videoCard.getByRole("slider", { name: "Seek" })).toBeEnabled();
	await videoCard.getByRole("button", { name: "Mute", exact: true }).click();
	await expect(videoCard.getByRole("button", { name: "Unmute", exact: true })).toBeVisible();
	await audioCard.hover();
	await expect(videoCard.locator(".canvas-player-controls")).toHaveCSS("opacity", "0");
	expect((await videoState()).paused).toBe(false);

	await page.mouse.click(volumeBounds.x + volumeBounds.width / 4, volumeBounds.y + volumeBounds.height / 2);
	const readAudioVolume = () => audio.evaluate((element: HTMLAudioElement) => element.volume);
	await expect.poll(readAudioVolume).toBeCloseTo(0.2, 1);
	const volume = String(await readAudioVolume());
	await expect(audioVolume).toHaveValue(volume);
	await audioMute.click();
	await expect(audioVolume).toHaveValue("0");
	await audioCard.getByRole("button", { name: "Unmute", exact: true }).click();
	await expect(audioVolume).toHaveValue(volume);
	await audioCard.getByRole("slider", { name: "Seek" }).click();
	await expect.poll(async () => (await audioState()).time).toBeGreaterThan(25);
	await expect(waveform.locator(".is-played").first()).toBeVisible();
	const audioSeekTime = (await audioState()).time;
	await audioPlay.click();
	await expect.poll(async () => (await audioState()).time).toBeGreaterThan(audioSeekTime);
	await videoCard.hover();
	const seek = (await videoCard.getByRole("slider", { name: "Seek" }).boundingBox())!;
	await page.mouse.click(seek.x + seek.width / 3, seek.y + seek.height / 2);
	await expect.poll(async () => (await videoState()).time).toBeGreaterThan(10);
	const pausedVideo = await videoState();
	expect(pausedVideo.paused).toBe(true);
	await videoPlay.click();
	await expect.poll(async () => (await videoState()).time).toBeGreaterThan(pausedVideo.time);
	expect((await audioState()).paused).toBe(true);

	const previousVideo = (await video.elementHandle())!;
	await sidebar.locator(".asset-row").filter({ hasText: "Other.md" }).click({ button: "middle" });
	await expect(board).toHaveCount(0);
	const detached = await previousVideo.evaluate((element) => {
		const media = element as HTMLVideoElement;
		return { paused: media.paused, time: media.currentTime };
	});
	expect(detached.paused).toBe(true);
	await page.getByRole("tab", { name: "Playback.canvas" }).click();
	await expect(videoPlay).toBeVisible();
	expect((await videoState()).paused).toBe(true);
	await videoPlay.click();
	await expect.poll(async () => (await videoState()).time).toBeGreaterThan(detached.time);
	const beforeMove = (await videoCard.boundingBox())!;
	await page.mouse.move(beforeMove.x + 20, beforeMove.y + 20);
	await page.mouse.down();
	await page.mouse.move(beforeMove.x + 48, beforeMove.y + 36, { steps: 4 });
	await page.mouse.up();
	await expect.poll(async () => (await videoCard.boundingBox())!.x).toBeGreaterThan(beforeMove.x);

	await videoCard.locator(".canvas-video-player").dblclick({ position: { x: 20, y: 20 } });
	await expect(page.getByRole("dialog", { name: "File preview" })).toBeVisible();
	expect((await videoState()).paused).toBe(true);
});

test("a file dropped on a canvas tab opens a preview tab, and a drop on the canvas creates a card", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	await expect.poll(async () => (await snapshot()).rootPath).toBeTruthy();
	const root = (await snapshot()).rootPath!;
	await mkdir(join(root, "项目"));
	const scriptPath = join(root, "项目", "文案.md");
	await copyFile(still, join(root, "项目", "参考.png"));
	await writeFile(join(root, "项目", "补充.md"), "## 场景备注\n\n补充说明。");
	await writeFile(scriptPath, `# 文案\n\n**开场**\n\n![[项目/参考.png|参考.png]]\n\n![[项目/补充]]\n\n${"Scene direction.\n\n".repeat(920)}## 最后一幕`);
	await expect.poll(async () => (await snapshot()).folders).toContain("项目");
	await page.evaluate(() => window.loom.createCanvasFile("项目"));
	const sidebar = page.locator(".library-sidebar");
	await sidebar.locator(".folder-main").filter({ hasText: /^项目$/ }).click();
	await sidebar.locator(".asset-row").filter({ hasText: "Untitled.canvas" }).click();
	const canvasTab = page.getByRole("tab", { name: "Untitled.canvas" });
	await expect(canvasTab).toHaveAttribute("aria-selected", "true");
	const file = sidebar.locator(".asset-row").filter({ hasText: "文案.md" });
	await file.dragTo(canvasTab, { targetPosition: { x: 4, y: 10 } });
	const fileTab = page.getByRole("tab", { name: "文案.md", exact: true });
	await expect(fileTab).toHaveAttribute("aria-selected", "true");
	await expect(fileTab).toHaveAccessibleDescription(/Preview tab/);
	await canvasTab.click();
	await expect(page.locator(".canvas-editor .canvas-empty")).toHaveText("Drag files here or add text to start.");
	await file.dragTo(page.locator(".canvas-surface"), { targetPosition: { x: 48, y: 56 } });
	const card = page.locator(".canvas-editor .canvas-file-markdown");
	const heading = card.getByRole("heading", { name: "文案", exact: true });
	await expect(heading).toBeVisible();
	await expect(card.locator("strong")).toHaveText("开场");
	await expect(card.locator(".markdown-note-embed").getByRole("heading", { name: "场景备注" })).toBeAttached();
	await expect(card.getByText("Double-click to read the full file.")).toBeAttached();
	await expect(card.getByRole("heading", { name: "最后一幕" })).toHaveCount(0);
	await card.hover();
	await page.mouse.wheel(0, 160);
	await expect.poll(() => card.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
	await page.mouse.wheel(0, -320);
	await expect.poll(() => card.evaluate((element) => element.scrollTop)).toBe(0);
	const preview = page.getByRole("dialog", { name: "File preview" });
	const embeddedImage = card.getByRole("img", { name: "参考.png" });
	await expect(embeddedImage).toBeVisible();
	await embeddedImage.click();
	await expect(preview).toHaveCount(0);
	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			this.items.find((item) => item.label === "Open original file")?.click();
			options?.callback?.();
		};
	});
	await embeddedImage.click({ button: "right" });
	await expect(preview.getByRole("img", { name: "参考.png" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(preview).toHaveCount(0);
	await heading.click();
	await expect(preview).toHaveCount(0);
	await heading.dblclick();
	const editor = preview.getByRole("textbox", { name: "Edit 文案.md" });
	await expect(editor).toBeVisible();
	await editor.press("ControlOrMeta+End");
	await expect(preview.getByRole("heading", { name: "最后一幕" })).toBeInViewport();
	await editor.press("ControlOrMeta+f");
	await expect(preview.locator(".cm-search")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(preview.locator(".cm-search")).toHaveCount(0);
	await expect(preview).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(preview).toHaveCount(0);

	await writeFile(scriptPath, "# 改过的文案");
	await expect(card.getByRole("heading", { name: "改过的文案" })).toBeVisible();
	await expect.poll(async () => (await readBoard(join(root, "项目", "Untitled.canvas"))).nodes[0]?.file).toBe("项目/文案.md");
});

test("switching from a canvas tab to icon mode selects the canvas and opens it on double-click", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const rootPath = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(rootPath).toBeTruthy();
	const root = (await rootPath())!;
	const path = join(root, "Board.canvas");
	await writeFile(join(root, "Note.md"), "# Reference");
	await writeFile(path, JSON.stringify({
		nodes: [{ id: "note", type: "file", file: "Note.md", x: 0, y: 0, width: 260, height: 180 }],
		edges: [],
	}));

	const sidebar = page.locator(".library-sidebar");
	const tabs = page.locator(".asset-tabs");
	const canvasTab = tabs.getByRole("tab", { name: "Board.canvas", exact: true });
	const tile = page.locator(".folder-browser .browser-tile").filter({ hasText: "Board.canvas" });
	const preview = page.getByRole("dialog", { name: "File preview", exact: true });
	const board = preview.getByRole("region", { name: "Canvas Board.canvas" });
	await sidebar.locator(".asset-row").filter({ hasText: "Board.canvas" }).click({ button: "middle" });
	await expect(canvasTab).toHaveAttribute("aria-selected", "true");
	await sidebar.getByRole("button", { name: "Icons", exact: true }).click();
	await expect(tile).toHaveClass(/selected/);
	await expect(tabs).toHaveCount(0);
	await expect(preview).toHaveCount(0);

	await tile.dblclick();
	await expect(board).toBeVisible();
	await expect(tabs).toHaveCount(0);

	await board.getByRole("heading", { name: "Reference", exact: true }).dblclick();
	await expect(preview.getByRole("textbox", { name: "Edit Note.md" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(preview).toHaveCount(1);
	await expect(board).toBeVisible();
	await board.getByRole("button", { name: "Text", exact: true }).click();
	await board.getByRole("textbox", { name: "Markdown text" }).fill("Edited in the preview");
	await board.getByRole("button", { name: "Done", exact: true }).click();
	await page.keyboard.press("Escape");
	await expect(preview).toHaveCount(0);
	await expect(tile).toBeVisible();
	await expect.poll(async () => (await readBoard(path)).nodes.some((node) => node.text === "Edited in the preview")).toBe(true);

	await sidebar.getByRole("button", { name: "List", exact: true }).click();
	await expect(canvasTab).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("region", { name: "Canvas Board.canvas" }).getByText("Edited in the preview")).toBeVisible();

	await sidebar.getByRole("button", { name: "Icons", exact: true }).click();
	await page.locator(".folder-browser .browser-tile").filter({ hasText: "Note.md" }).click();
	await sidebar.getByRole("button", { name: "List", exact: true }).click();
	await expect(canvasTab).toHaveAttribute("aria-selected", "false");
	await expect(tabs.getByRole("tab", { name: "Note.md", selected: true })).toBeVisible();
});

test("canvas controls follow selection and connect cards from their ports", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const rootPath = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(rootPath).toBeTruthy();
	const { filename, relativePath } = await page.evaluate(async (document: CanvasDocument) => {
		const asset = await window.loom.createCanvasFile("");
		const initial = (await window.loom.readCanvas(asset.assetId))!;
		await window.loom.saveCanvas(asset.assetId, document, initial.revision);
		return asset;
	}, {
		nodes: [
			{ id: "source", type: "text", text: "Source", x: 0, y: 120, width: 150, height: 100 },
			{ id: "target", type: "text", text: "Target", x: 290, y: 0, width: 150, height: 100 },
		],
		edges: [],
	} satisfies CanvasDocument);
	const path = join((await rootPath())!, relativePath);
	await page.locator(".library-sidebar .asset-row").filter({ hasText: filename }).click();
	const board = page.getByRole("region", { name: `Canvas ${filename}` });
	const create = board.getByRole("toolbar", { name: "Create cards" });
	const selection = board.getByRole("toolbar", { name: "Selection actions" });
	await create.getByRole("button", { name: "Text", exact: true }).press("ArrowRight");
	await expect(create.getByRole("button", { name: "Add files", exact: true })).toBeFocused();
	await expect(create.getByRole("button", { name: "Group", exact: true })).toHaveCount(0);
	await expect(selection).toHaveCount(0);

	const source = board.locator(".canvas-node").filter({ hasText: "Source" });
	const target = board.locator(".canvas-node").filter({ hasText: "Target" });
	await source.locator(".canvas-handle").click();
	await expect(selection.getByRole("button", { name: "Edit" })).toBeVisible();
	const surface = board.locator(".canvas-surface");
	const grid = () => surface.evaluate((element) => {
		const { backgroundImage, backgroundSize, backgroundPositionX, backgroundPositionY } = getComputedStyle(element);
		return {
			spacing: parseFloat(backgroundSize),
			radius: parseFloat(backgroundImage.match(/[\d.]+px(?=\)+$)/)?.[0] ?? ""),
			x: parseFloat(backgroundPositionX),
			y: parseFloat(backgroundPositionY),
		};
	});
	const beforeGrid = await grid();
	const beforeZoom = (await selection.boundingBox())!;
	await board.getByRole("button", { name: "Zoom in" }).click();
	expect((await selection.boundingBox())!.width).toBe(beforeZoom.width);
	const zoomedGrid = await grid();
	expect(zoomedGrid.spacing).toBeCloseTo(beforeGrid.spacing * 1.25);
	expect(zoomedGrid.radius).toBeCloseTo(beforeGrid.radius * 1.25);
	await surface.dispatchEvent("wheel", { deltaX: 80, deltaY: 40 });
	await expect(async () => {
		const pannedGrid = await grid();
		expect(pannedGrid.x).toBeCloseTo(zoomedGrid.x - 80);
		expect(pannedGrid.y).toBeCloseTo(zoomedGrid.y - 40);
	}).toPass();
	await board.getByRole("button", { name: "Fit view" }).click();

	await source.getByRole("button", { name: "Connect from right" }).dragTo(target.locator(".canvas-handle"));
	await expect(board.getByRole("textbox", { name: "Connection label" })).toBeVisible();
	await expect.poll(async () => (await readBoard(path)).edges[0]).toMatchObject({
		fromNode: "source", toNode: "target", fromSide: "right",
	});

	await surface.dblclick({ position: { x: 38, y: 48 } });
	await expect(board.getByRole("textbox", { name: "Markdown text" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(board.getByRole("textbox", { name: "Markdown text" })).toHaveCount(0);
});

test("the canvas toolbar and context menu add files from the library", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const rootPath = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(rootPath).toBeTruthy();
	const root = (await rootPath())!;
	const file = await page.evaluate(() => window.loom.createCanvasFile(""));
	const path = join(root, file.relativePath);
	await mkdir(join(root, "Project"));
	await writeFile(join(root, "Project", "Alpha.md"), "# First");
	await writeFile(join(root, "Project", "Beta.md"), "# Second");
	await writeFile(join(root, "..", "Outside.md"), "# Outside the library");
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.map((asset) => asset.relativePath))
		.toEqual(expect.arrayContaining(["Project/Alpha.md", "Project/Beta.md"]));
	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			this.items.find((item) => item.label === "Add files")?.click();
			options?.callback?.();
		};
	});

	await page.locator(".library-sidebar .asset-row").filter({ hasText: file.filename }).click();
	const board = page.getByRole("region", { name: `Canvas ${file.filename}` });
	await expect(board.getByText("Drag files here or add text to start.")).toBeVisible();
	const addFiles = board.getByRole("button", { name: "Add files", exact: true });
	const surface = board.locator(".canvas-surface");
	const location = { x: 48, y: 56 };
	await addFiles.click();
	const picker = page.getByRole("dialog", { name: "Add files", exact: true });
	const search = picker.getByRole("combobox", { name: "Search library files" });
	await expect(search).toBeFocused();
	await search.fill("Outside.md");
	await expect(picker.getByRole("status")).toHaveText("No matching files in this library.");
	await picker.getByRole("button", { name: "Clear search", exact: true }).click();
	await expect(search).toHaveValue("");
	await expect(search).toBeFocused();
	await search.press("Escape");
	await expect(picker).toHaveCount(0);
	expect((await readBoard(path)).nodes).toEqual([]);

	await surface.click({ button: "right", position: location });
	await expect(picker).toBeVisible();
	const dialogBounds = (await picker.boundingBox())!;
	await page.mouse.click(dialogBounds.x - 8, dialogBounds.y + dialogBounds.height / 2);
	await expect(picker).toHaveCount(0);
	expect((await readBoard(path)).nodes).toEqual([]);

	await surface.click({ button: "right", position: location });
	await search.fill("project/");
	await expect(picker.getByRole("option")).toHaveCount(2);
	await expect(picker.getByRole("button")).toHaveCount(1);
	await search.press("ArrowDown");
	await expect(picker.getByRole("option", { name: /Beta.md/ })).toHaveAttribute("aria-selected", "true");
	await expect(search).toBeFocused();
	await picker.getByRole("option", { name: /Alpha.md/ }).click();
	await expect(picker).toHaveCount(0);
	await expect.poll(async () => (await readBoard(path)).nodes.map((node) => node.file)).toEqual(["Project/Alpha.md"]);
	const viewport = (await surface.boundingBox())!;
	const card = (await board.locator(".canvas-card").first().boundingBox())!;
	expect(card.x - viewport.x).toBeCloseTo(location.x);
	expect(card.y - viewport.y).toBeCloseTo(location.y);

	await addFiles.click();
	await search.fill("Beta.md");
	await search.press("Enter");
	await expect.poll(async () => (await readBoard(path)).nodes.map((node) => node.file)).toEqual(["Project/Alpha.md", "Project/Beta.md"]);
});

test("a canvas file card locates its library file in list and icon mode", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	await expect.poll(async () => (await snapshot()).rootPath).toBeTruthy();
	const root = (await snapshot()).rootPath!;
	await mkdir(join(root, "Project"));
	await writeFile(join(root, "Project", "Reference.md"), "# Reference");
	await writeFile(join(root, "Board.canvas"), JSON.stringify({
		nodes: [{ id: "reference", type: "file", file: "Project/Reference.md", x: 0, y: 0, width: 244, height: 172 }],
		edges: [],
	} satisfies CanvasDocument));
	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			this.items.find((item) => item.enabled && item.label === "Locate in Library")?.click();
			options?.callback?.();
		};
	});

	const sidebar = page.locator(".library-sidebar");
	const row = (name: string) => sidebar.locator(".asset-list .asset-row").filter({ hasText: name });
	const board = page.getByRole("region", { name: "Canvas Board.canvas" });
	const card = board.locator(".canvas-handle").filter({ hasText: "Reference.md" });
	const boardTab = page.getByRole("tab", { name: "Board.canvas", exact: true });
	await row("Board.canvas").click();
	await sidebar.locator(".folder-row").filter({ hasText: "Project" }).locator(".folder-chevron.expanded").click();
	await sidebar.getByRole("button", { name: "Search files", exact: true }).click();
	await sidebar.getByPlaceholder("Filter files").fill("Board.canvas");
	await expect(row("Reference.md")).toHaveCount(0);
	await card.click({ button: "right" });
	await expect(row("Reference.md")).toHaveClass(/selected/);
	await expect(row("Reference.md")).toBeInViewport();
	await expect(boardTab).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("tab", { name: "Reference.md", exact: true })).toHaveCount(0);

	await row("Board.canvas").click();
	await sidebar.getByRole("button", { name: "Icons", exact: true }).click();
	await page.locator('.browser-tile[data-tooltip="Board.canvas"]').dblclick();
	await card.click({ button: "right" });
	const tile = page.locator('.browser-tile[data-tooltip="Project/Reference.md"]');
	await expect(tile).toHaveClass(/selected/);
	await expect(tile).toBeInViewport();
	await expect(page.getByRole("dialog", { name: "File preview" })).toHaveCount(0);
});

test("clicking Table rows and Graph nodes selects files without opening them", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const rootPath = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(rootPath).toBeTruthy();
	const root = (await rootPath())!;
	await writeFile(join(root, "Open.md"), "# Open");
	await writeFile(join(root, "Other.md"), "# Other");
	const canvas = JSON.stringify({ nodes: [], edges: [] });
	await writeFile(join(root, "Board.canvas"), canvas);
	const sidebar = page.locator(".library-sidebar");
	const views = sidebar.locator(".library-views");
	const table = views.getByRole("button", { name: "Table", exact: true });
	const graph = views.getByRole("button", { name: "Graph", exact: true });
	const library = views.getByRole("button", { name: "Library", exact: true });
	const node = (filename: string) => page.locator(`.graph-node[aria-label="${filename}"]`);
	const row = page.locator(".table-view").getByRole("row", { name: /Board\.canvas/ });
	const canvasDetails = page.locator(".details-content").getByText(`${Buffer.byteLength(canvas)} B`, { exact: true });
	const openTab = page.getByRole("tab", { name: "Open.md", exact: true });

	await sidebar.locator(".asset-row").filter({ hasText: "Open.md" }).click();
	await table.click();
	await row.click();
	await expect(table).toHaveAttribute("aria-pressed", "true");
	await expect(row).toHaveClass(/selected/);
	await expect(canvasDetails).toBeVisible();
	await library.click();
	await expect(openTab).toHaveAttribute("aria-selected", "true");

	await graph.click();
	await node("Board.canvas").locator(".graph-node-outline").click();
	await expect(node("Board.canvas")).toHaveClass(/selected/);
	await expect(graph).toHaveAttribute("aria-pressed", "true");
	await node("Other.md").locator(".graph-node-outline").click();
	await expect(node("Other.md")).toHaveClass(/selected/);
	await library.click();
	await expect(openTab).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("tab", { name: "Board.canvas", exact: true })).toHaveCount(0);

	await sidebar.getByRole("button", { name: "Icons", exact: true }).click();
	await graph.click();
	await node("Board.canvas").locator(".graph-node-outline").click();
	await expect(node("Board.canvas")).toHaveClass(/selected/);
	await expect(graph).toHaveAttribute("aria-pressed", "true");
	await table.click();
	await row.click();
	await expect(table).toHaveAttribute("aria-pressed", "true");
	await expect(row).toHaveClass(/selected/);
	await expect(canvasDetails).toBeVisible();
	await library.click();
	await expect(page.getByRole("tab", { name: "Board.canvas", exact: true })).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: "File preview", exact: true })).toHaveCount(0);
});

test("closing the workspace flushes the latest canvas edit", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	await expect.poll(async () => (await snapshot()).rootPath).toBeTruthy();
	const root = (await snapshot()).rootPath!;
	await page.evaluate(() => window.loom.createCanvasFile(""));
	await page.locator(".library-sidebar .asset-row").filter({ hasText: "Untitled.canvas" }).click();
	const board = page.locator(".canvas-editor");
	await board.getByRole("button", { name: "Text", exact: true }).click();
	await board.getByRole("textbox", { name: "Markdown text" }).fill("Last edit");
	await electronApp!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); });
	await expect.poll(async () => (await readBoard(join(root, "Untitled.canvas"))).nodes[0]?.text).toBe("Last edit");
});

test("box selection moves multiple canvas cards together", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	await expect.poll(async () => (await snapshot()).rootPath).toBeTruthy();
	const path = join((await snapshot()).rootPath!, "Selection.canvas");
	await writeFile(path, JSON.stringify({
		nodes: [
			{ id: "first", type: "text", text: "First", x: 0, y: 0, width: 150, height: 100 },
			{ id: "second", type: "text", text: "Second", x: 200, y: 0, width: 150, height: 100 },
		],
	}));
	await page.locator(".library-sidebar .asset-row").filter({ hasText: "Selection.canvas" }).click();
	const cards = page.locator(".canvas-editor .canvas-card");
	await expect(cards).toHaveCount(2);
	const first = (await cards.first().boundingBox())!;
	const second = (await cards.last().boundingBox())!;
	await page.mouse.move(first.x - 12, first.y - 12);
	await page.mouse.down();
	await page.mouse.move(second.x + second.width + 8, second.y + second.height + 8, { steps: 5 });
	await expect(page.locator(".canvas-marquee")).toBeVisible();
	await page.mouse.up();
	await expect(page.locator(".canvas-card.selected")).toHaveCount(2);

	const body = (await cards.first().locator(".canvas-note").boundingBox())!;
	const x = body.x + body.width / 2, y = body.y + body.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 28, y + 22, { steps: 5 });
	await page.mouse.up();
	await expect.poll(async () => (await readBoard(path)).nodes[0]?.x).toBeGreaterThan(0);
	const [a, b] = (await readBoard(path)).nodes;
	expect(b!.x - a!.x).toBe(200);
	expect(a!.y).toBe(b!.y);
});

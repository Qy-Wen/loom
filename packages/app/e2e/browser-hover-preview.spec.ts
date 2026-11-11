import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

const CLIP = new URL("../../core/tests/fixtures/media/clip.mp4", import.meta.url);
const GIF = new URL("../../core/tests/fixtures/media/animated.gif", import.meta.url);
const STILL = new URL("../../core/tests/fixtures/media/still.png", import.meta.url);

function isPlaying(element: Element): boolean {
	const video = element as HTMLVideoElement;
	return !video.paused && video.currentTime > 0.05;
}

function isReleased(element: Element): boolean {
	const video = element as HTMLVideoElement;
	return video.paused && video.getAttribute("src") === null;
}

test.beforeEach(async ({ electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	test.setTimeout(60_000);
});

test("video and GIF icons animate only while hovered and release video playback on leave", async ({ loomPage: page }) => {
	await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	const originals: string[] = [];
	page.on("request", (request) => { if (request.url().startsWith("loom-asset://asset/")) originals.push(request.url()); });
	await copyFile(CLIP, join(root, "clip.mp4"));
	await copyFile(CLIP, join(root, "second.mp4"));
	await copyFile(GIF, join(root, "animation.GIF"));
	await copyFile(STILL, join(root, "photo.png"));
	await mkdir(join(root, "empty"));
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(4);
	await page.locator(".library-display-tabs").getByRole("button", { name: "Icons", exact: true }).click();
	const browser = page.locator(".folder-browser");
	const tile = (name: string) => browser.locator(".browser-tile").filter({ has: page.getByText(name, { exact: true }) });
	const clip = tile("clip.mp4");
	const gif = tile("animation.GIF");
	for (const item of [clip, gif]) {
		await expect.poll(() => item.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await expect(item.locator("img")).toHaveAttribute("src", /^loom-asset:\/\/thumb\//);
	}
	await expect(browser.locator("video")).toHaveCount(0);
	expect(originals).toEqual([]);

	const bounds = await clip.locator(".browser-tile-thumb").boundingBox();
	await clip.hover();
	const first = clip.locator("video");
	await expect.poll(() => first.evaluate(isPlaying)).toBe(true);
	await expect(clip.locator(".browser-hover-preview.ready")).toBeVisible();
	expect(await first.evaluate((element) => {
		const video = element as HTMLVideoElement;
		return { muted: video.muted, loop: video.loop, inline: video.playsInline, controls: video.controls };
	})).toEqual({ muted: true, loop: true, inline: true, controls: false });
	expect(await clip.locator(".browser-tile-thumb").boundingBox()).toEqual(bounds);
	await expect(browser.locator("video")).toHaveCount(1);
	const firstHandle = (await first.elementHandle())!;

	await tile("second.mp4").hover();
	const second = tile("second.mp4").locator("video");
	await expect.poll(() => second.evaluate(isPlaying)).toBe(true);
	await expect(browser.locator("video")).toHaveCount(1);
	expect(await firstHandle.evaluate(isReleased)).toBe(true);
	const secondHandle = (await second.elementHandle())!;

	await gif.hover();
	const animated = gif.locator(".browser-hover-preview.ready img");
	await expect(animated).toBeVisible();
	await expect(animated).toHaveAttribute("src", /^loom-asset:\/\/asset\//);
	expect(await animated.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(16);
	await expect(browser.locator("video")).toHaveCount(0);
	expect(await secondHandle.evaluate(isReleased)).toBe(true);

	await tile("photo.png").hover();
	await expect(browser.locator(".browser-hover-preview")).toHaveCount(0);
	await expect(gif.locator("img")).toHaveAttribute("src", /^loom-asset:\/\/thumb\//);
	expect(new Set(originals.map((url) => new URL(url).pathname)).size).toBe(3);

	await clip.hover();
	await expect.poll(() => clip.locator("video").evaluate(isPlaying)).toBe(true);
	const leaving = (await clip.locator("video").elementHandle())!;
	await tile("empty").dblclick();
	await expect(browser.locator(".browser-crumb.current")).toHaveText("empty");
	await expect(browser.locator("video")).toHaveCount(0);
	expect(await leaving.evaluate(isReleased)).toBe(true);
	await firstHandle.dispose();
	await secondHandle.dispose();
	await leaving.dispose();
});

test("failed hover playback falls back to the still and context menus or rename stop playback", async ({ loomPage: page }) => {
	await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await copyFile(CLIP, join(root, "clip.mp4"));
	await writeFile(join(root, "broken.mp4"), "unavailable video");
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(2);
	const assets = (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets;
	const brokenId = assets.find((asset) => asset.filename === "broken.mp4")!.assetId;
	const errors: string[] = [];
	const requests: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("request", (request) => requests.push(request.url()));
	await page.locator(".library-display-tabs").getByRole("button", { name: "Icons", exact: true }).click();
	const browser = page.locator(".folder-browser");
	const tile = (name: string) => browser.locator(".browser-tile").filter({ has: page.getByText(name, { exact: true }) });
	await tile("broken.mp4").hover();
	await expect.poll(() => requests.some((url) => url.startsWith(`loom-asset://asset/${brokenId}`))).toBe(true);
	await expect(tile("broken.mp4").locator(".browser-hover-preview")).toHaveCount(0);
	await expect(tile("broken.mp4").locator(".asset-badge")).toHaveText("MP4");

	const clip = tile("clip.mp4");
	await clip.hover();
	await expect.poll(() => clip.locator("video").evaluate(isPlaying)).toBe(true);
	await clip.click({ button: "right" });
	await expect(browser.locator("video")).toHaveCount(0);
	await browser.locator(".browser-bar").hover();
	await clip.hover();
	await expect.poll(() => clip.locator("video").evaluate(isPlaying)).toBe(true);
	await clip.click();
	await clip.press("F2");
	await expect(browser.locator(".browser-tile-rename input")).toBeFocused();
	await expect(browser.locator("video")).toHaveCount(0);
	await browser.locator(".browser-tile-rename input").press("Escape");
	await expect(browser.locator("video")).toHaveCount(0);
	await browser.locator(".browser-bar").hover();
	await clip.hover();
	await expect.poll(() => clip.locator("video").evaluate(isPlaying)).toBe(true);
	expect(errors).toEqual([]);
});

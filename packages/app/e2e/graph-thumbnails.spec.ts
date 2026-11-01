import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

const STILL = new URL("../../core/tests/fixtures/media/still.png", import.meta.url);
const CLIP = new URL("../../core/tests/fixtures/media/clip.mp4", import.meta.url);

for (const colorScheme of ["light", "dark"] as const) {
	test(`graph previews media and keeps type-colored borders in ${colorScheme} mode`, async ({ loomPage, electronApp }, testInfo) => {
		test.skip(!electronApp, "isolated library required");
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
		const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
		await copyFile(STILL, join(root, "photo.png"));
		await copyFile(CLIP, join(root, "clip.mp4"));
		await writeFile(join(root, "notes.md"), "# notes");
		await writeFile(join(root, "sound.wav"), "unavailable audio");
		await writeFile(join(root, "archive.zip"), "file");
		await writeFile(join(root, "broken.png"), "unavailable image");
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(6);
		await loomPage.emulateMedia({ colorScheme });
		await loomPage.locator(".library-views").getByRole("button", { name: "Graph", exact: true }).click();

		const nodes = loomPage.locator(".graph-node");
		const node = (filename: string) => nodes.filter({ has: loomPage.locator("title", { hasText: new RegExp(`^${filename.replaceAll(".", "\\.")}$`) }) });
		await expect(nodes).toHaveCount(6);
		const photo = node("photo.png");
		const video = node("clip.mp4");
		await expect.poll(() => photo.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await expect.poll(() => video.locator("video").evaluate((media) => (media as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
		expect(await video.locator("video").evaluate((media) => (media as HTMLVideoElement).paused)).toBe(true);
		await expect(node("notes.md").locator(".asset-badge")).toHaveText("MD");
		await expect(node("sound.wav").locator(".asset-badge")).toHaveText("♪");
		await expect(node("archive.zip").locator(".asset-badge")).toHaveText("ZIP");
		await expect(node("broken.png").locator(".asset-badge")).toHaveText("PNG");
		const colors = new Map<string, string>();
		for (const [filename, type] of [["photo.png", "image"], ["clip.mp4", "video"], ["notes.md", "text"], ["sound.wav", "audio"], ["archive.zip", "other"]] as const) {
			const color = await loomPage.locator(`.graph-legend-swatch[style*="--lm-asset-${type}"]`).evaluate((swatch) => getComputedStyle(swatch).borderTopColor);
			colors.set(type, color);
			await expect(node(filename).locator("circle")).toHaveCSS("stroke", color);
		}
		expect(new Set(colors.values()).size).toBe(5);

		// The preview must leave the node's body and rim available for selection and linking.
		const radius = Number(await photo.locator("circle").getAttribute("r"));
		await photo.locator("circle").click();
		await expect(photo).toHaveClass(/selected/);
		expect(Number(await photo.locator("circle").getAttribute("r"))).toBeGreaterThan(radius);
		await expect(photo.locator("circle")).toHaveCSS("stroke", colors.get("image")!);
		await expect(photo.locator("circle")).toHaveCSS("stroke-width", "3px");
		const from = (await photo.locator("circle").boundingBox())!;
		const to = (await video.locator("circle").boundingBox())!;
		await loomPage.mouse.move(from.x + from.width * 0.925, from.y + from.height / 2);
		await loomPage.mouse.down();
		await loomPage.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
		await expect(video).toHaveClass(/drop-target/);
		await expect(video.locator("circle")).toHaveCSS("stroke", colors.get("video")!);
		await loomPage.mouse.up();
		await expect(loomPage.getByRole("dialog", { name: "Create relation" })).toBeVisible();
		await loomPage.keyboard.press("Escape");

		// Replacing an unreadable file recovers its preview without reopening Graph.
		await copyFile(STILL, join(root, "broken.png"));
		await expect.poll(() => node("broken.png").locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		const screenshot = testInfo.outputPath(`graph-thumbnails-${colorScheme}.png`);
		await loomPage.locator(".graph-view").screenshot({ path: screenshot });
		await testInfo.attach(`graph-thumbnails-${colorScheme}`, { path: screenshot, contentType: "image/png" });
	});
}

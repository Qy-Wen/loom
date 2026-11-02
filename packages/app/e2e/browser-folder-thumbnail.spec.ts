import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

const STILL = new URL("../../core/tests/fixtures/media/still.png", import.meta.url);
const CLIP = new URL("../../core/tests/fixtures/media/clip.mp4", import.meta.url);

for (const colorScheme of ["light", "dark"] as const) {
	test(`browser folders show flat empty, media, document and subfolder artwork in ${colorScheme} mode`, async ({ loomPage, electronApp }, testInfo) => {
		test.skip(!electronApp, "isolated library required");
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
		const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
		for (const path of ["Empty", "Photos", "Videos", "Documents", "Audio", "Other", "Subfolders/Child"]) {
			await mkdir(join(root, path), { recursive: true });
		}
		await copyFile(STILL, join(root, "Photos", "cover.png"));
		await copyFile(CLIP, join(root, "Videos", "clip.mp4"));
		await writeFile(join(root, "Photos", "aaa.md"), "# notes");
		await writeFile(join(root, "Documents", "notes.md"), "# notes");
		await writeFile(join(root, "Audio", "sound.wav"), "unavailable audio");
		await writeFile(join(root, "Other", "archive.zip"), "file");
		await copyFile(STILL, join(root, "Subfolders", "Child", "nested.png"));
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(7);
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).folders.length).toBe(8);
		await loomPage.emulateMedia({ colorScheme });
		await loomPage.locator(".library-display-tabs").getByRole("button", { name: "Icons", exact: true }).click();
		const browser = loomPage.locator(".folder-browser");
		const tile = (name: string) => browser.locator(".browser-tile.folder").filter({ has: loomPage.locator(".browser-tile-name", { hasText: new RegExp(`^${name}$`) }) });
		await expect(tile("Empty").locator(".browser-folder-art")).toHaveClass(/empty/);
		await expect(tile("Empty").locator(".browser-folder-content")).toHaveCount(0);
		await expect(tile("Photos").locator("img")).toBeVisible();
		await expect.poll(async () => tile("Photos").locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await expect(tile("Videos").locator("img")).toBeVisible();
		await expect.poll(async () => tile("Videos").locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await expect(tile("Documents").locator(".browser-folder-file-label")).toHaveText("MD");
		await expect(tile("Audio").locator(".browser-folder-file-label")).toHaveText("♪");
		await expect(tile("Other").locator(".browser-folder-file-label")).toHaveText("ZIP");
		await expect(tile("Subfolders").locator(".browser-folder-child")).toBeVisible();
		await expect(tile("Subfolders").locator("img")).toHaveCount(0);
		// Flat fills only: no outlines, gradients, shadows or tilted content cards.
		await expect(tile("Empty").locator(".browser-folder-back path")).toHaveCSS("stroke", "none");
		await expect(tile("Empty").locator(".browser-folder-front path")).toHaveCSS("stroke", "none");
		await expect(tile("Subfolders").locator(".browser-folder-child path")).toHaveCSS("stroke", "none");
		await expect(browser.locator("linearGradient")).toHaveCount(0);
		await expect(tile("Photos").locator(".browser-folder-front")).toHaveCSS("filter", "none");
		await expect(tile("Photos").locator(".browser-folder-content")).toHaveCSS("filter", "none");
		await expect(tile("Photos").locator(".browser-folder-content")).toHaveCSS("transform", "none");
		expect(await tile("Photos").locator(".browser-folder-art").evaluate((art) => [...art.children].map((child) => child.classList[0]))).toEqual(["browser-folder-back", "browser-folder-content", "browser-folder-front"]);
		const screenshot = testInfo.outputPath(`folder-thumbnails-${colorScheme}.png`);
		await browser.screenshot({ path: screenshot });
		await testInfo.attach(`folder-thumbnails-${colorScheme}`, { path: screenshot, contentType: "image/png" });
		// Artwork scales with the slider and the contents remain within the thumbnail.
		const art = tile("Photos").locator(".browser-folder-art");
		const initialWidth = (await art.boundingBox())!.width;
		const slider = browser.getByRole("slider", { name: "Icon size", exact: true });
		await slider.focus();
		await slider.press("End");
		expect((await art.boundingBox())!.width).toBeGreaterThan(initialWidth);
		for (const key of ["Home", "End"]) {
			await slider.press(key);
			const thumb = (await tile("Photos").locator(".browser-tile-thumb").boundingBox())!;
			const card = (await tile("Photos").locator(".browser-folder-content").boundingBox())!;
			expect(card.x).toBeGreaterThan(thumb.x);
			expect(card.y).toBeGreaterThan(thumb.y);
			expect(card.x + card.width).toBeLessThan(thumb.x + thumb.width);
			expect(card.y + card.height).toBeLessThan(thumb.y + thumb.height);
		}
		// A live library update changes a media cover to a file, then to an empty folder.
		await unlink(join(root, "Photos", "cover.png"));
		await expect(tile("Photos").locator(".browser-folder-file-label")).toHaveText("MD");
		await unlink(join(root, "Photos", "aaa.md"));
		await expect(tile("Photos").locator(".browser-folder-art")).toHaveClass(/empty/);
		await tile("Subfolders").dblclick();
		await expect(tile("Child").locator("img")).toBeVisible();
	});
}

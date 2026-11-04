import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveMediaBinary } from "../../core/src/media/binaries.ts";
import { expect, test } from "./loom.ts";

for (const mode of ["List", "Icons"] as const) {
	test(`video keyboard controls in ${mode} mode and full screen`, async ({ loomPage: page, electronApp }) => {
		test.skip(!electronApp, "isolated library required");
		test.setTimeout(45_000);
		const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
		// Long enough to distinguish a five-second seek from clamping at the end of the short shared fixture.
		await promisify(execFile)(resolveMediaBinary("ffmpeg"), [
			"-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=10", "-t", "20",
			"-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "keyboard.mp4"),
		], { windowsHide: true });
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(1);
		const sidebar = page.locator(".library-sidebar");
		if (mode === "Icons") {
			await sidebar.getByRole("group", { name: "File display", exact: true }).getByRole("button", { name: "Icons", exact: true }).click();
			await page.locator(".browser-tile").filter({ hasText: "keyboard.mp4" }).dblclick();
		} else {
			await sidebar.locator(".asset-row").filter({ hasText: "keyboard.mp4" }).click();
		}
		const stage = page.locator(".media-stage");
		const video = stage.locator("video");
		const state = () => video.evaluate((node: HTMLVideoElement) => ({ paused: node.paused, time: node.currentTime, volume: node.volume, muted: node.muted }));
		await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(1);
		await expect(stage).toBeFocused();
		await page.keyboard.press("Space");
		await expect.poll(async () => (await state()).paused).toBe(false);
		await page.keyboard.press("Space");
		await expect.poll(async () => (await state()).paused).toBe(true);

		await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 8; node.volume = 0.5; });
		await page.keyboard.press("ArrowRight");
		await expect.poll(async () => (await state()).time).toBeCloseTo(13, 1);
		await page.keyboard.press("ArrowLeft");
		await expect.poll(async () => (await state()).time).toBeCloseTo(8, 1);
		await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 2; });
		await page.keyboard.press("ArrowLeft");
		await expect.poll(async () => (await state()).time).toBe(0);
		await video.evaluate((node: HTMLVideoElement) => { node.currentTime = node.duration - 2; });
		await page.keyboard.press("ArrowRight");
		await expect.poll(() => video.evaluate((node: HTMLVideoElement) => Math.abs(node.currentTime - node.duration))).toBeLessThan(0.1);

		await page.keyboard.press("ArrowUp");
		expect((await state()).volume).toBeCloseTo(0.55);
		await page.keyboard.press("ArrowDown");
		expect((await state()).volume).toBeCloseTo(0.5);
		await video.evaluate((node: HTMLVideoElement) => { node.volume = 0.99; });
		await page.keyboard.press("ArrowUp");
		expect((await state()).volume).toBe(1);
		await video.evaluate((node: HTMLVideoElement) => { node.volume = 0.01; });
		await page.keyboard.press("ArrowDown");
		expect(await state()).toMatchObject({ volume: 0, muted: true });
		await video.evaluate((node: HTMLVideoElement) => { node.volume = 0.8; node.muted = true; });
		await page.keyboard.press("ArrowUp");
		expect(await state()).toMatchObject({ volume: 0.05, muted: false });

		// Keyboard work in another panel must not control the video.
		const composer = page.getByRole("textbox").first();
		await composer.fill("hello");
		await composer.press("End");
		await composer.press("Space");
		await composer.press("ArrowDown");
		await composer.press("ArrowLeft");
		expect(await state()).toMatchObject({ volume: 0.05, paused: true });
		expect(await composer.evaluate((node) => node.textContent?.replaceAll("\u00a0", " "))).toBe("hello ");
		await stage.locator(".media-viewport").click();
		await expect(stage).toBeFocused();
		await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 8; });
		await page.keyboard.press("Control+ArrowRight");
		expect((await state()).time).toBeCloseTo(8, 1);
		// Sliders retain their native keyboard behavior.
		await stage.getByRole("slider", { name: "Volume", exact: true }).focus();
		await page.keyboard.press("ArrowRight");
		expect((await state()).volume).toBeCloseTo(0.1);
		expect((await state()).time).toBeCloseTo(8, 1);
		await stage.getByRole("button", { name: "Play", exact: true }).focus();
		await page.keyboard.press("Space");
		await expect.poll(async () => (await state()).paused).toBe(false);
		await page.keyboard.press("Space");
		await expect.poll(async () => (await state()).paused).toBe(true);

		const bar = mode === "Icons" ? page.locator(".preview-overlay-bar") : stage;
		await bar.getByRole("button", { name: "Full screen", exact: true }).click();
		await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
		await expect(stage).toBeFocused();
		// Let native full-screen transitions settle before testing the exit. macOS can omit the window event
		// when the preceding test has just closed a full-screen window; the overlay uses the same fallback.
		await page.waitForTimeout(1600);
		await page.keyboard.press("Space");
		await expect.poll(async () => (await state()).paused).toBe(false);
		await page.keyboard.press("Space");
		await expect.poll(async () => (await state()).paused).toBe(true);
		await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 8; });
		await page.keyboard.press("ArrowRight");
		await expect.poll(async () => (await state()).time).toBeCloseTo(13, 1);
		await page.keyboard.press("ArrowUp");
		expect((await state()).volume).toBeCloseTo(0.15);
		await bar.getByRole("button", { name: "Exit full screen", exact: true }).click();
		await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
		await expect(stage).toBeFocused();
	});
}

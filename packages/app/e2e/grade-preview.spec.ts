import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("grade previews cross IPC as bytes and refresh during continuous edits", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(45_000);
	const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await copyFile(new URL("../../core/tests/fixtures/media/still.png", import.meta.url), join(root, "preview.png"));
	await page.locator(".asset-row").filter({ hasText: "preview.png" }).click();
	const assetId = await page.evaluate(async () => (await window.loom.getLibrarySnapshot()).assets.find((a) => a.filename === "preview.png")!.assetId);
	const previews = await page.evaluate(async (id) => {
		const first = await window.loom.previewImageGrade(id, { exposure: 0.5 } as Parameters<typeof window.loom.previewImageGrade>[1]);
		const second = await window.loom.previewImageGrade(id, { exposure: 1 } as Parameters<typeof window.loom.previewImageGrade>[1]);
		if (!first || !second || !ArrayBuffer.isView(first) || !ArrayBuffer.isView(second)) throw new Error("Preview IPC must return binary data");
		return { first: Array.from(first), second: Array.from(second) };
	}, assetId);
	expect(previews.first.slice(0, 3)).toEqual([255, 216, 255]);
	await page.locator('.preview-actions button[aria-label="Edit"]').click();
	await expect(page.locator(".grade-panel")).toBeVisible();
	// Let the real warmup finish before replacing the IPC handler with a gate.
	await page.evaluate(async (id) => { await window.loom.previewImageGrade(id, {} as Parameters<typeof window.loom.previewImageGrade>[1], undefined, true); }, assetId);
	await electronApp!.evaluate(({ ipcMain }, previews) => {
		const state = globalThis as unknown as { gradeGate: { calls: number; pending: Array<() => void> } };
		state.gradeGate = { calls: 0, pending: [] };
		ipcMain.removeHandler("loom:previewImageGrade");
		ipcMain.handle("loom:previewImageGrade", () => {
			const index = state.gradeGate.calls++;
			return new Promise<Uint8Array>((resolve) => state.gradeGate.pending.push(() => resolve(Uint8Array.from(index % 2 ? previews.second : previews.first))));
		});
	}, previews);
	const count = () => electronApp!.evaluate(() => (globalThis as unknown as { gradeGate: { calls: number } }).gradeGate.calls);
	const release = () => electronApp!.evaluate(() => { (globalThis as unknown as { gradeGate: { pending: Array<() => void> } }).gradeGate.pending.shift()!(); });
	const slider = page.locator('.grade-field input[type="range"]').first();
	const image = page.locator(".grade-frame img");
	await slider.focus();
	await page.keyboard.press("ArrowRight");
	await expect.poll(count).toBe(1);
	await page.keyboard.press("ArrowRight");
	await expect(slider).toHaveValue("0.02");
	await release();
	await expect.poll(count).toBe(2);
	// The second render is still gated: the first completed frame must be shown.
	await expect(image).toHaveAttribute("src", /^blob:/);
	const firstUrl = await image.getAttribute("src");
	await release();
	await expect.poll(() => image.getAttribute("src")).not.toBe(firstUrl);
	await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

	// A stale color frame must not replace the current preview after rotation.
	const beforeRotate = await image.getAttribute("src");
	await slider.focus();
	await page.keyboard.press("ArrowRight");
	await expect.poll(count).toBe(3);
	await page.getByRole("button", { name: "Rotate right", exact: true }).click();
	await release();
	await expect.poll(count).toBe(4);
	expect(await image.getAttribute("src")).toBe(beforeRotate);
	await release();
	await expect.poll(() => image.getAttribute("src")).not.toBe(beforeRotate);
});

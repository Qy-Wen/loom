import { copyFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("saving a grade replaces the image and video only after confirmation and keeps library metadata", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(60_000);
	const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	const filenames = ["still.png", "clip.mp4"];
	for (const name of filenames) {
		await copyFile(new URL(`../../core/tests/fixtures/media/${name}`, import.meta.url), join(root, name));
	}
	await expect(page.locator(".asset-row")).toHaveCount(2);
	const before = await page.evaluate(async (names) => {
		const ids = (await window.loom.getLibrarySnapshot()).assets.filter((asset) => names.includes(asset.filename)).map((asset) => asset.assetId);
		for (const id of ids) {
			await window.loom.setFavorite(id, true);
			await window.loom.addAssetTag(id, "Keep this tag");
		}
		await window.loom.createRelation(ids[0], ids[1], "related to");
		const snapshot = await window.loom.getLibrarySnapshot();
		return { snapshot, relations: await window.loom.listGraphRelations() };
	}, filenames);

	for (const name of filenames) {
		const path = join(root, name);
		const original = await readFile(path);
		await page.locator(".asset-row").filter({ hasText: name }).click();
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		const panel = page.locator(".grade-panel");
		const slider = panel.locator('input[type="range"]').first();
		await slider.press("End");
		await expect(slider).toHaveValue("3");
		const save = panel.getByRole("button", { name: "Save", exact: true });
		const confirmation = page.getByRole("dialog", { name: "Overwrite original file?", exact: true });
		const cancel = confirmation.getByRole("button", { name: "Cancel", exact: true });
		await save.click();
		await expect(confirmation).toContainText(name);
		await expect(cancel).toBeFocused();
		expect(await readFile(path)).toEqual(original);
		await cancel.click();
		await expect(confirmation).toBeHidden();
		await expect(save).toBeFocused();
		await expect(slider).toHaveValue("3");
		expect(await readFile(path)).toEqual(original);
		await save.click();
		await confirmation.getByRole("button", { name: "Overwrite", exact: true }).click();
		await expect.poll(async () => ({
			value: await slider.inputValue(),
			errors: await panel.locator(".grade-error").allTextContents(),
		}), { message: `${name} adjustments should reset after saving`, timeout: 20_000 }).toMatchObject({ value: "0" });
		expect(await readFile(path)).not.toEqual(original);
	}

	const after = await page.evaluate(async () => ({
		snapshot: await window.loom.getLibrarySnapshot(),
		relations: await window.loom.listGraphRelations(),
	}));
	const identities = (assets: typeof before.snapshot.assets) => assets.map(({ filename, assetId }) => [filename, assetId]).sort();
	expect(identities(after.snapshot.assets)).toEqual(identities(before.snapshot.assets));
	expect(after.snapshot.favoriteAssetIds).toEqual(before.snapshot.favoriteAssetIds);
	expect(after.snapshot.tags).toEqual(before.snapshot.tags);
	expect(after.snapshot.assetTags).toEqual(before.snapshot.assetTags);
	expect(after.relations).toEqual(before.relations);

	const still = after.snapshot.assets.find((asset) => asset.filename === "still.png")!;
	const saved = await readFile(join(root, "still.png"));
	await expect(page.evaluate((assetId) => window.loom.saveImageGrade(assetId, { exposure: 1 } as Parameters<typeof window.loom.saveImageGrade>[1], "missing.cube"), still.assetId)).rejects.toThrow();
	expect(await readFile(join(root, "still.png"))).toEqual(saved);
	expect((await readdir(root)).filter((name) => name !== ".loom").sort()).toEqual([...filenames].sort());

	const copy = await page.evaluate((assetId) => window.loom.saveImageGrade(assetId, { exposure: -1 } as Parameters<typeof window.loom.saveImageGrade>[1], undefined, "copy.png"), still.assetId);
	expect(copy.assetId).not.toBe(still.assetId);
	expect(copy.path).toBe("copy.png");
	expect(await readFile(join(root, copy.path))).not.toEqual(saved);
	expect(await readFile(join(root, "still.png"))).toEqual(saved);
});

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

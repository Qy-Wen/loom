import { copyFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("media descriptions and indexes fail and retry independently", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library and settings required");
	await expect(loomPage.locator(".library-sidebar")).toBeVisible();
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await copyFile(new URL("../../core/tests/fixtures/media/still.png", import.meta.url), join(root, "fixture.png"));
	let failDescription = true;
	let failIndex = true;
	let descriptions = 0;
	let indexes = 0;
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const describing = request.url === "/describe";
		if (describing) descriptions++;
		else indexes++;
		response.setHeader("content-type", "application/json");
		if (describing ? failDescription : failIndex) {
			response.writeHead(400);
			response.end(JSON.stringify({ error: { message: describing ? "Description unavailable" : "Index unavailable" } }));
		} else if (describing) {
			response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ caption: "A blue reference image", tags: ["Landscape", "Blue", "landscape"] }) } }] }));
		} else {
			const { input } = JSON.parse(body) as { input: string[] };
			response.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [0.5, 0.5] })) }));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		await loomPage.evaluate((origin) => window.loom.saveModelSettings({
			vlm: { requestUrl: `${origin}/describe`, apiKey: "", model: "vision", enabled: true },
			embedding: { requestUrl: `${origin}/embed`, apiKey: "", model: "vectors", enabled: true },
		}), origin);
		const row = loomPage.locator(".library-sidebar .asset-row").filter({ hasText: "fixture.png" });
		await expect(row).toBeVisible();
		await row.click();
		await loomPage.getByRole("button", { name: "Details", exact: true }).click();
		const details = loomPage.locator(".details-content");
		const group = details.getByRole("region", { name: "Description & index", exact: true });
		const combined = group.getByRole("button", { name: "Describe and index", exact: true });
		const caption = group.getByRole("region", { name: "Caption status", exact: true });
		const index = group.getByRole("region", { name: "Index status", exact: true });
		await expect(caption).toContainText("Not described");
		await expect(index).toHaveCount(0);
		await combined.click();
		await expect(caption).toContainText("Description unavailable");
		await expect(index).toHaveCount(0);
		expect(indexes).toBe(0);

		failDescription = false;
		await caption.getByRole("button", { name: "Describe", exact: true }).click();
		await expect(group.locator(".description-caption")).toContainText("A blue reference image");
		await expect(index).toContainText("Not indexed");
		await expect(caption.locator("dt", { hasText: /^Model$/ })).toHaveCount(0);
		const captionStatus = caption.locator(".analysis-status > span");
		await captionStatus.hover();
		await expect(loomPage.getByRole("tooltip")).toHaveText("Model: vision");
		await loomPage.mouse.move(0, 0);
		expect(indexes).toBe(0);
		await index.getByRole("button", { name: "Index", exact: true }).click();
		await expect(index).toContainText("Index unavailable");
		await expect(caption).not.toContainText("Index unavailable");
		await expect(group.locator(".description-caption")).toContainText("A blue reference image");

		failIndex = false;
		await index.getByRole("button", { name: "Index", exact: true }).click();
		await expect(index.locator(".analysis-status > span")).toHaveText("ready");
		await expect(index).not.toContainText("Chunks");
		await expect(index).not.toContainText("Index unavailable");
		await expect(index.getByRole("button", { name: "Re-index", exact: true })).toBeEnabled();
		const indexStatus = index.locator(".analysis-status > span");
		const tooltip = loomPage.getByRole("tooltip");
		expect(await indexStatus.getAttribute("title")).toBeNull();
		await indexStatus.hover();
		await expect(tooltip).toBeVisible({ timeout: 500 });
		await expect(tooltip).toHaveText("Model: vectors\n1 child / 1 parent");
		await expect(index.locator("dt", { hasText: /^Model$/ })).toHaveCount(0);
		await expect(indexStatus).toHaveAttribute("aria-describedby", (await tooltip.getAttribute("id"))!);
		await loomPage.mouse.move(0, 0);
		await expect(tooltip).toHaveCount(0);
		await indexStatus.focus();
		await expect(tooltip).toBeVisible({ timeout: 500 });
		await indexStatus.press("Escape");
		await expect(tooltip).toHaveCount(0);
		await indexStatus.press("Tab");
		expect(descriptions).toBe(2);
		expect(indexes).toBe(2);

		// A model change makes the description stale, so even a ready index is hidden.
		await loomPage.evaluate(() => window.loom.saveModelSettings({ vlm: { model: "other-vision" } }));
		await loomPage.reload();
		await row.click();
		await loomPage.getByRole("button", { name: "Details", exact: true }).click();
		await expect(caption).toContainText("stale");
		await expect(index).toHaveCount(0);

		failDescription = true;
		await caption.getByRole("button", { name: "Re-describe", exact: true }).click();
		await expect(caption).toContainText("Description unavailable");
		await expect(index).toHaveCount(0);
		expect(indexes).toBe(2);

		// The combined action stops on description failure and exposes index errors separately.
		await combined.click();
		await expect.poll(() => descriptions).toBe(4);
		await expect(combined).toBeEnabled();
		expect(indexes).toBe(2);
		await expect(index).toHaveCount(0);
		failDescription = false;
		failIndex = true;
		await combined.click();
		await expect(index).toContainText("Index unavailable");
		await expect(group.locator(".description-caption")).toContainText("A blue reference image");
		await expect(caption).not.toContainText("Index unavailable");
		expect(descriptions).toBe(5);
		failIndex = false;
		await index.getByRole("button", { name: "Index", exact: true }).click();
		await expect(index).not.toContainText("Index unavailable");
		await expect(index.locator(".analysis-status > span")).toHaveText("ready");
		expect(descriptions).toBe(5);
		expect(indexes).toBe(4);

		await combined.click();
		const dialog = loomPage.getByRole("dialog", { name: "Already described", exact: true });
		await dialog.getByRole("button", { name: "Describe and index", exact: true }).click();
		await expect.poll(() => indexes).toBe(5);
		await expect(index.locator(".analysis-status > span")).toHaveText("ready");
		expect(descriptions).toBe(6);
		await expect(group.locator(".description-caption")).not.toContainText("## Caption");
		await expect(group.locator(".description-suggestions .tag-chip")).toHaveCount(2);
		const snapshot = await loomPage.evaluate(() => window.loom.getLibrarySnapshot());
		const assetId = snapshot.assets.find((asset) => asset.filename === "fixture.png")!.assetId;
		expect(snapshot.assetTags.filter((tag) => tag.assetId === assetId)).toHaveLength(0);
		await loomPage.evaluate((id) => window.loom.addAssetTag(id, "Manual"), assetId);
		const landscape = group.locator('.description-suggestions .tag-chip').filter({ hasText: "Landscape" });
		const addLandscape = landscape.getByRole("button", { name: "Add Landscape to tags", exact: true });
		const addBackground = await addLandscape.evaluate((button) => getComputedStyle(button).backgroundColor);
		await addLandscape.hover();
		await expect(addLandscape).not.toHaveCSS("background-color", addBackground);
		await addLandscape.focus();
		await addLandscape.press("Tab");
		await loomPage.keyboard.press("Shift+Tab");
		await expect(addLandscape).toHaveCSS("outline-style", "solid");
		await addLandscape.press("Enter");
		await expect(landscape).toHaveCount(0);
		await expect(group.getByRole("button", { name: "Add Blue to tags", exact: true })).toBeEnabled();
		await expect(details.locator(".tag-editor .tag-chip")).toHaveCount(2);
		await group.getByRole("button", { name: "Add Blue to tags", exact: true }).click();
		await expect(group.locator(".description-suggestions")).toHaveCount(0);
		await expect(details.locator(".tag-editor .tag-chip")).toHaveCount(3);

		// Automatic tag application does not depend on the following index succeeding.
		const removeBlue = details.locator(".tag-editor").getByRole("button", { name: "Remove Blue", exact: true });
		const removeBackground = await removeBlue.evaluate((button) => getComputedStyle(button).backgroundColor);
		await removeBlue.hover();
		await expect(removeBlue).not.toHaveCSS("background-color", removeBackground);
		await removeBlue.focus();
		await removeBlue.press("Tab");
		await loomPage.keyboard.press("Shift+Tab");
		await expect(removeBlue).toHaveCSS("outline-style", "solid");
		await removeBlue.press("Enter");
		await expect(group.getByRole("button", { name: "Add Blue to tags", exact: true })).toBeEnabled();
		await group.getByRole("checkbox", { name: "Automatically add description tags" }).check();
		failIndex = true;
		await combined.click();
		await dialog.getByRole("button", { name: "Describe and index", exact: true }).click();
		await expect(index).toContainText("Index unavailable");
		await expect(group.locator(".description-suggestions")).toHaveCount(0);
		await expect(details.locator(".tag-editor .tag-chip")).toHaveCount(3);
		expect(descriptions).toBe(7);
		expect(indexes).toBe(6);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("structured audio descriptions display suggestions and a collapsed transcript", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	await expect(loomPage.locator(".library-sidebar")).toBeVisible();
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	const wave = Buffer.alloc(46);
	wave.write("RIFF"); wave.writeUInt32LE(38, 4); wave.write("WAVEfmt ", 8);
	wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
	wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
	wave.write("data", 36); wave.writeUInt32LE(2, 40);
	await writeFile(join(root, "voice.wav"), wave);
	await electronApp!.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler("loom:getAudioWriteupStatus");
		ipcMain.handle("loom:getAudioWriteupStatus", (_event, assetId: string) => ({
			assetId, supported: true, status: "ready", stale: false,
			description: { caption: "A speaker reads a greeting.", tags: ["speech", "greeting"], transcript: "00:01 Hello there." },
		}));
	});
	await loomPage.locator(".library-sidebar .asset-row").filter({ hasText: "voice.wav" }).click();
	await loomPage.getByRole("button", { name: "Details", exact: true }).click();
	const group = loomPage.getByRole("region", { name: "Description & index", exact: true });
	await expect(group.locator(".media-description-body")).toContainText("A speaker reads a greeting.");
	await expect(group.locator(".description-suggestions .tag-chip")).toHaveCount(2);
	const transcript = group.locator(".description-transcript");
	await expect(transcript).not.toHaveAttribute("open");
	await expect(transcript.locator("p")).not.toBeVisible();
	await transcript.locator("summary").click();
	await expect(transcript.locator("p")).toHaveText("00:01 Hello there.");
});

import { copyFile } from "node:fs/promises";
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
			response.end(JSON.stringify({ choices: [{ message: { content: "A blue reference image" } }] }));
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
		await expect(group.locator(".media-writeup")).toContainText("A blue reference image");
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
		await expect(group.locator(".media-writeup")).toContainText("A blue reference image");

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
		await expect(group.locator(".media-writeup")).toContainText("A blue reference image");
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
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

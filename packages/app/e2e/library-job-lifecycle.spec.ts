import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("switching libraries aborts detail jobs, drops old UI results, and reopening allows retry", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(45000);
	const original = await loomPage.evaluate(() => window.loom.getModelSettings());
	const previousRoot = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	const root = await mkdtemp(join(tmpdir(), "loom-job-e2e-"));
	const a = join(root, "a"), b = join(root, "b");
	await mkdir(a); await mkdir(b);
	const fixture = new URL("../../core/tests/fixtures/media/still.png", import.meta.url);
	await copyFile(fixture, join(a, "first.png"));
	await copyFile(fixture, join(b, "second.png"));
	const pending: ServerResponse[] = [];
	let released = false;
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) { /* consume input */ }
		if (released) {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ caption: "A fresh caption", tags: [] }) } }] }));
		} else pending.push(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	async function open(path: string) {
		await electronApp!.evaluate(({ dialog }, path) => {
			const original = dialog.showOpenDialog;
			dialog.showOpenDialog = (async () => {
				dialog.showOpenDialog = original;
				return { canceled: false, filePaths: [path] };
			}) as typeof dialog.showOpenDialog;
		}, path);
		await loomPage.evaluate(() => window.loom.openLibrary());
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath).toBe(path);
	}
	try {
		await loomPage.evaluate((requestUrl) => window.loom.saveModelSettings({
			vlm: { requestUrl, apiKey: "", model: "test", enabled: true },
		}), `http://127.0.0.1:${(server.address() as AddressInfo).port}/describe`);
		await open(a);
		const asset = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets[0]!;
		await loomPage.getByText("first.png", { exact: true }).first().click();
		await loomPage.getByRole("button", { name: "Details", exact: true }).click();
		const describe = loomPage.getByRole("button", { name: "Describe", exact: true });
		await expect(describe).toBeEnabled();
		await describe.click();
		await expect.poll(() => pending.length).toBe(1);
		await expect(loomPage.getByRole("button", { name: "Describing…", exact: true })).toBeDisabled();
		await open(b);
		await loomPage.getByText("second.png", { exact: true }).first().click();
		await expect(describe).toBeEnabled();
		// An old response arriving after the new selection cannot supply its caption/error/busy state.
		for (const response of pending) response.end(JSON.stringify({ choices: [{ message: { content: "OLD CAPTION" } }] }));
		await expect(loomPage.getByText("OLD CAPTION", { exact: false })).toHaveCount(0);
		await open(a);
		await loomPage.getByText("first.png", { exact: true }).first().click();
		await expect(describe).toBeEnabled();
		expect((await loomPage.evaluate((id) => window.loom.getImageVlmStatus(id), asset.assetId)).status).toBe("failed");
		released = true;
		await describe.click();
		await expect.poll(async () => (await loomPage.evaluate((id) => window.loom.getImageVlmStatus(id), asset.assetId)).status).toBe("ready");
		await expect(loomPage.getByText("A fresh caption", { exact: false }).first()).toBeVisible();
		await expect(loomPage.getByRole("button", { name: "Re-describe", exact: true })).toBeEnabled();
	} finally {
		released = true;
		for (const response of pending) response.destroy();
		await open(previousRoot);
		await loomPage.getByRole("button", { name: "Chat", exact: true }).click();
		await loomPage.evaluate((settings) => window.loom.saveModelSettings(settings), original);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
});

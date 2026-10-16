import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "./loom.ts";

test("non-Chat slots probe and persist complete request URLs without rewriting", async ({ loomPage }) => {
	const calls: Array<{ path: string; method?: string; model?: string }> = [];
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
		calls.push({ path: request.url ?? "", method: request.method, model: body.model });
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({
			data: [{ embedding: [0.1] }], results: [{ index: 0, relevance_score: 0.8 }],
			choices: [{ message: { content: "pong" } }],
		}));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const original = await loomPage.evaluate(() => window.loom.getModelSettings());
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const rows = [
		{ id: "embedding", title: "Text embedding", path: "/custom/embed/?version=2" },
		{ id: "rerank", title: "Rerank", path: "/v2/custom-rank" },
		{ id: "vlm", title: "VLM", path: "/vision/inference" },
		{ id: "audio", title: "Audio", path: "/audio/inference?region=cn" },
	] as const;
	const settings = loomPage.getByRole("dialog", { name: "Settings", exact: true });
	try {
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		for (const row of rows) {
			const slot = settings.getByRole("group", { name: row.title, exact: true });
			const toggle = slot.getByRole("switch", { name: `Enable ${row.title}`, exact: true });
			if (await toggle.isChecked()) await toggle.locator("..").click();
			const input = slot.getByRole("textbox", { name: "Request URL", exact: true });
			await expect(input).toHaveAttribute("placeholder", /\/(embeddings|rerank|chat\/completions)$/);
			await input.fill(origin + row.path);
			await slot.getByRole("textbox", { name: "Model", exact: true }).fill(`test-${row.id}`);
			await toggle.locator("..").click();
			await expect(slot.getByText("Connected", { exact: true })).toBeVisible();
		}
		await settings.getByRole("button", { name: "Close settings", exact: true }).click();
		await expect(settings).toHaveCount(0);
		const saved = await loomPage.evaluate(() => window.loom.getModelSettings());
		for (const row of rows) {
			expect(saved[row.id].baseUrl).toBe(origin + row.path);
			expect(calls.filter((call) => call.model === `test-${row.id}`)).toEqual([
				{ path: row.path, method: "POST", model: `test-${row.id}` },
			]);
		}
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		for (const row of rows) {
			await expect(settings.getByRole("group", { name: row.title, exact: true }).getByRole("textbox", { name: "Request URL", exact: true })).toHaveValue(origin + row.path);
		}
		const embedding = settings.getByRole("group", { name: "Text embedding", exact: true });
		const url = embedding.getByRole("textbox", { name: "Request URL", exact: true });
		await url.fill("invalid-in-progress"); await url.press("Tab");
		await expect(settings.getByRole("alert")).toContainText("Request URL");
		await embedding.getByRole("switch", { name: "Enable Text embedding", exact: true }).locator("..").click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getModelSettings())).embedding.enabled).toBe(false);
		expect((await loomPage.evaluate(() => window.loom.getModelSettings())).embedding.baseUrl).toBe(origin + rows[0].path);
		await expect(url).toHaveValue("invalid-in-progress");
	} finally {
		if (await settings.count()) await settings.getByRole("button", { name: "Close settings", exact: true }).click();
		await loomPage.evaluate((draft) => window.loom.saveModelSettings(draft), original);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

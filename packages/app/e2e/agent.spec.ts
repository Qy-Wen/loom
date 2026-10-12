import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

function reply(response: ServerResponse, tool?: string, args = {}) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const delta = tool ? { tool_calls: [{ index: 0, id: `call-${tool}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: "Generated and saved the result." };
	response.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}

test("Electron reconnects to an owned specialist approval, restores history, and forks before the question", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const parsed = JSON.parse(body) as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string }> };
			const names = parsed.tools?.map((tool) => tool.function.name) ?? [];
			if (parsed.messages.some((message) => message.role === "tool")) reply(response);
			else if (names.includes("run_create_agent")) reply(response, "run_create_agent", { goal: "save generated.txt" });
			else reply(response, "write", { path: "generated.txt", content: "generated" });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		await loomPage.evaluate(async (baseUrl) => {
			const current = await window.loom.getModelSettings();
			await window.loom.saveModelSettings({ ...current, chat: { baseUrl, model: "demo", apiKey: "test", enabled: true } });
			await window.loom.setAgentPermission("basic");
		}, url);
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBeGreaterThan(0);
		const before = await loomPage.evaluate(() => window.loom.listSessions());
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(before.length + 1);
		const session = (await loomPage.evaluate(() => window.loom.listSessions())).find((row) => !before.some((prior) => prior.id === row.id))!;
		const composer = loomPage.getByRole("textbox");
		await composer.fill("Generate a file");
		await composer.press("Enter");
		await expect(loomPage.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
		await loomPage.reload();
		await expect(loomPage.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
		const parentCard = loomPage.locator(".tool-call").filter({ has: loomPage.getByRole("button", { name: /run_create_agent/ }) });
		const argumentsText = await parentCard.locator(".tool-call-result").innerText();
		expect(JSON.parse(argumentsText.replace(/^arguments\s*/, ""))).toEqual({ goal: "save generated.txt" });
		await loomPage.getByRole("button", { name: "Approve", exact: true }).click();
		await expect(loomPage.getByText("Generated and saved the result.", { exact: true }).first()).toBeVisible();
		const record = await loomPage.evaluate((id) => window.loom.getSession(id), session.id);
		expect(record.messages.filter((message) => message.role === "user")).toHaveLength(1);
		const root = await loomPage.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
		expect(await readFile(join(root!, "generated.txt"), "utf8")).toBe("generated");
		await loomPage.reload();
		await expect(loomPage.getByText("Generated and saved the result.", { exact: true }).first()).toBeVisible();
		const first = record.messages.find((message) => message.role === "user")!;
		const fork = await loomPage.evaluate(({ id, entry }) => window.loom.branchBefore(id, entry), { id: record.id, entry: String(first.id) });
		expect(fork.title).toBe(`${record.title}（分支）`);
		expect(fork.messages).toEqual([]);
		expect((await loomPage.evaluate((id) => window.loom.getSession(id), record.id)).status).toBe("archived");
	} finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Electron shows partial text before the model finishes streaming", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	const finish = Promise.withResolvers<void>();
	let providerFinished = false;
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (content: string, finishReason: string | null = null) => `data: ${JSON.stringify({ id: "stream", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`;
		response.write(chunk("First words before completion"));
		void finish.promise.then(() => { providerFinished = true; response.end(chunk(" and final words", "stop") + "data: [DONE]\n\n"); });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await loomPage.evaluate(async (baseUrl) => {
			const current = await window.loom.getModelSettings();
			await window.loom.saveModelSettings({ ...current, chat: { baseUrl, model: "demo", apiKey: "test", enabled: true } });
		}, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBeGreaterThan(0);
		const count = (await loomPage.evaluate(() => window.loom.listSessions())).length;
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(count + 1);
		await expect(loomPage.getByRole("tab", { name: "New session", selected: true, exact: true })).toBeVisible();
		const composer = loomPage.getByRole("textbox");
		await composer.fill("Test streaming"); await composer.press("Enter");
		await expect(loomPage.getByText("First words before completion", { exact: true })).toBeVisible({ timeout: 5000 });
		expect(providerFinished).toBe(false);
		finish.resolve();
		await expect(loomPage.getByText("First words before completion and final words", { exact: true })).toBeVisible();
	} finally { finish.resolve(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

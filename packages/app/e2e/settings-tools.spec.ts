import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, saveChatEndpoint, test } from "./loom.ts";

let callId = 0;
function reply(response: ServerResponse, tool?: string, args: unknown = {}) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const delta = tool ? { tool_calls: [{ index: 0, id: `call-${++callId}-${tool}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: "SETTINGS_TOOL_DONE" };
	response.end(`data: ${JSON.stringify({ id: "settings", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "settings", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}

test("Agent settings tools confirm language/Chat/key writes and synchronize the open UI without changing the conversation", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated user data required");
	test.setTimeout(60_000);
	const key = "SETTINGS_TOOL_TEST_KEY";
	const toolResults: string[] = [];
	let createdSessionId: string | undefined;
	let action: { name: string; args: unknown };
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const messages = (JSON.parse(body) as { messages: Array<{ role: string; content: string }> }).messages;
			if (messages.at(-1)?.role === "tool") { toolResults.push(messages.at(-1)!.content); reply(response); }
			else reply(response, action.name, action.args);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		await saveChatEndpoint(loomPage, baseUrl);
		await loomPage.evaluate(() => window.loom.setAgentPermission("standard"));
		const before = await loomPage.evaluate(() => window.loom.listSessions());
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		const sessionId = (await loomPage.evaluate(() => window.loom.listSessions())).find((row) => !before.some((prior) => prior.id === row.id))!.id;
		createdSessionId = sessionId;
		const originalLanguage = await loomPage.evaluate(() => window.loom.getGeneralSettings());
		async function send(name: string, args: unknown, approval = true, afterSend?: () => Promise<void>) {
			action = { name, args };
			const count = toolResults.length;
			await loomPage.getByRole("textbox").fill("Perform the requested settings operation");
			await loomPage.getByRole("textbox").press("Enter");
			if (approval) {
				await expect(loomPage.getByRole("button", { name: /^(Approve|允许)$/, exact: true })).toBeVisible();
				await loomPage.getByRole("button", { name: /^(Approve|允许)$/, exact: true }).click();
			}
			if (afterSend) await afterSend();
			await expect.poll(() => toolResults.length).toBe(count + 1);
			await expect(loomPage.getByTestId("copilot-message-list").getByText("SETTINGS_TOOL_DONE", { exact: true })).toHaveCount(count + 1);
			await expect(loomPage.getByRole("button", { name: /^(Conversation model|会话模型)$/, exact: true })).toBeEnabled();
		}
		await send("get_settings", {}, false);
		expect(toolResults.at(-1)).toContain('"catalog"'); expect(toolResults.at(-1)).not.toContain(key);
		await send("update_settings", { language: "zh-CN" });
		await expect(loomPage.locator("html")).toHaveAttribute("lang", "zh-CN");
		expect((await loomPage.evaluate(() => window.loom.getGeneralSettings())).reopenLastLibrary).toBe(originalLanguage.reopenLastLibrary);
		await send("update_settings", { language: "en", chat: { upsert: [{ id: "agent-configured", kind: "custom", name: "Agent-configured", requestUrl: baseUrl + "/responses", models: [{ id: "tool-model", reasoning: true, input: ["text", "image"], contextWindow: 32000, maxTokens: 4096 }], apiKey: key }] } }, true, async () => {
			await loomPage.getByRole("button", { name: /^(Settings|设置)$/, exact: true }).click();
		});
		await expect(loomPage.locator("html")).toHaveAttribute("lang", "en");
		const settings = loomPage.locator(".settings-dialog");
		const provider = settings.locator(".settings-chat-provider").filter({ hasText: "Agent-configured" });
		await expect(provider.locator(".settings-probe.is-ok")).toBeVisible();
		await expect(provider.getByRole("switch", { name: "Enable tool-model", exact: true })).toBeChecked();
		expect(JSON.stringify(await loomPage.evaluate(() => window.loom.getChatSettings()))).not.toContain(key);
		const userData = await electronApp!.evaluate(({ app }) => app.getPath("userData"));
		for (const file of ["chat-models.json", "chat-credentials.json"]) expect(await readFile(join(userData, file), "utf8")).not.toContain(key);
		await settings.getByRole("button", { name: "Close settings", exact: true }).click();
		await send("get_settings", { chatProvider: "agent-configured" }, false);
		expect(toolResults.at(-1)).toContain('"hasApiKey": true'); expect(toolResults.at(-1)).not.toContain(key);
		await send("update_settings", { chat: { upsert: [{ id: "agent-configured", clearApiKey: true, modelEnabled: { "tool-model": false } }] } });
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(provider.getByRole("switch", { name: "Enable tool-model", exact: true })).not.toBeChecked();
		await expect(provider.locator(".settings-probe.is-error")).toBeVisible();
		await settings.getByRole("button", { name: "Close settings", exact: true }).click();
		expect((await loomPage.evaluate((id) => window.loom.getSession(id), sessionId)).model?.provider).toBe("e2e-chat");
	} finally {
		if (createdSessionId) await loomPage.evaluate((id) => window.loom.deleteSession(id), createdSessionId);
		server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

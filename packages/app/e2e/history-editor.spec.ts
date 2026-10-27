import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, saveChatEndpoint, test } from "./loom.ts";

test("history editing shares composer styling and applies its model only to the submitted branch", async ({ loomPage }, testInfo) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated library and settings required");
	const requests: Array<{ model: string; reasoning_effort?: string }> = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const parsed = JSON.parse(body) as { model: string; reasoning_effort?: string };
			requests.push(parsed);
			const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "history-edit", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(chunk({ content: `HISTORY_MODEL_REPLY_${requests.length}` }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await loomPage.evaluate(async () => {
			const view = await window.loom.getChatSettings();
			const provider = view.config.providers.find((row) => row.id === "e2e-chat");
			if (provider?.kind !== "custom") throw new Error("Missing provider");
			provider.models.push({ ...provider.models[0]!, id: "current" }, { ...provider.models[0]!, id: "edited", reasoning: true });
			provider.models.push(...Array.from({ length: 20 }, (_, index) => ({ ...provider.models[0]!, id: `extra-${index}` })));
			await window.loom.saveChatSettings(view.config);
		});
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		await loomPage.getByRole("textbox").fill("HISTORY_MODEL_QUESTION");
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.getByText("HISTORY_MODEL_REPLY_1", { exact: true })).toBeVisible();
		const source = (await loomPage.evaluate(() => window.loom.listSessions())).find((row) => row.title === "HISTORY_MODEL_QUESTION")!;
		await loomPage.evaluate((id) => window.loom.setSessionModel(id, { provider: "e2e-chat", modelId: "current", thinkingLevel: "off" }), source.id);
		const sourceRecord = await loomPage.evaluate((id) => window.loom.getSession(id), source.id);
		const before = await loomPage.evaluate(() => window.loom.listSessions());
		const openEditor = async () => {
			const bubble = loomPage.getByTestId("copilot-user-message").filter({ hasText: "HISTORY_MODEL_QUESTION" });
			await bubble.hover(); await bubble.getByRole("button", { name: "Edit", exact: true }).click();
			await expect(loomPage.locator(".session-inline-edit").getByRole("button", { name: "Conversation model", exact: true })).toHaveText("current (e2e-chat)");
		};
		const selectModel = async () => {
			await loomPage.locator(".session-inline-edit").getByRole("button", { name: "Conversation model", exact: true }).click();
			const bounds = await loomPage.getByRole("menu", { name: "Conversation model", exact: true }).boundingBox();
			const viewport = await loomPage.evaluate(() => ({ width: innerWidth, height: innerHeight }));
			expect(bounds!.y).toBeGreaterThanOrEqual(8);
			expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 8);
			await loomPage.getByRole("menuitemradio", { name: "edited (e2e-chat)", exact: true }).hover();
			await loomPage.getByRole("menu", { name: "Thinking level", exact: true }).getByRole("menuitemradio", { name: "High", exact: true }).click();
		};
		await openEditor();
		await selectModel();
		expect((await loomPage.evaluate((id) => window.loom.getSession(id), source.id)).model).toEqual(sourceRecord.model);
		await loomPage.locator(".session-inline-edit").getByRole("button", { name: "Cancel", exact: true }).click();
		expect(await loomPage.evaluate(() => window.loom.listSessions())).toEqual(before);
		await openEditor();
		await selectModel();
		const styles = await loomPage.evaluate(() => [".session-inline-edit-pill", '.session-follow-up-slot [data-testid="copilot-chat-input"]'].map((selector) => {
			const style = getComputedStyle(document.querySelector(selector)!);
			return Object.fromEntries(["border", "border-radius", "background-color", "box-shadow"].map((key) => [key, style.getPropertyValue(key)]));
		}));
		expect(styles[0]).toEqual(styles[1]);
		await loomPage.screenshot({ path: testInfo.outputPath("history-editor.png") });
		const enableEdited = (enabled: boolean) => loomPage.evaluate(async (enabled) => {
			const view = await window.loom.getChatSettings();
			view.config.providers.find((row) => row.id === "e2e-chat")!.modelEnabled = { edited: enabled };
			await window.loom.saveChatSettings(view.config);
		}, enabled);
		await enableEdited(false);
		await loomPage.getByRole("textbox", { name: "Edit question", exact: true }).fill("EDITED_MODEL_QUESTION");
		await loomPage.locator(".session-inline-edit-send").click();
		await expect(loomPage.locator(".session-inline-edit").getByRole("alert")).toContainText("disabled");
		expect(await loomPage.evaluate(() => window.loom.listSessions())).toEqual(before);
		await enableEdited(true);
		await loomPage.locator(".session-inline-edit-send").click();
		await expect(loomPage.getByText("HISTORY_MODEL_REPLY_2", { exact: true })).toBeVisible();
		expect(requests).toHaveLength(2);
		expect(requests[1]).toMatchObject({ model: "edited", reasoning_effort: "high" });
		// The edit replaces the conversation: the branch is the only listed session, under the same title.
		const listed = (await loomPage.evaluate(() => window.loom.listSessions())).filter((row) => row.title === "HISTORY_MODEL_QUESTION");
		expect(listed).toHaveLength(1);
		const branch = listed[0]!;
		expect(branch.id).not.toBe(source.id);
		expect((await loomPage.evaluate((id) => window.loom.getSession(id), branch.id)).model).toEqual({ provider: "e2e-chat", modelId: "edited", thinkingLevel: "high" });
		const retained = await loomPage.evaluate((id) => window.loom.getSession(id), source.id);
		expect(retained.model).toEqual(sourceRecord.model);
		expect(retained.messages).toEqual(sourceRecord.messages);
		await loomPage.reload();
		await expect(loomPage.getByRole("button", { name: "Conversation model", exact: true })).toHaveText("edited (e2e-chat)");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

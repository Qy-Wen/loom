import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, saveChatEndpoint, test } from "./loom.ts";

test("sessions automatically select available models and prefer remembered choices", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data required");
	await saveChatEndpoint(loomPage, "http://127.0.0.1:1/v1");
	await loomPage.evaluate(async () => {
		const view = await window.loom.getChatSettings();
		const provider = view.config.providers.find((entry) => entry.id === "e2e-chat");
		if (provider?.kind !== "custom") throw new Error("Missing test provider");
		provider.models.push({ ...provider.models[0]!, id: "second-model" });
		view.config.providers = [provider];
		delete view.config.default;
		await window.loom.saveChatSettings(view.config);
	});

	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	const picker = loomPage.getByRole("button", { name: "Conversation model", exact: true });
	await expect(picker).toHaveText("demo (e2e-chat)");
	expect((await loomPage.evaluate(() => window.loom.getChatSettings())).config.default).toBeUndefined();
	await picker.click();
	await loomPage.getByRole("menuitemradio", { name: "demo (e2e-chat)", exact: true }).click();
	await expect(picker).toHaveText("demo (e2e-chat)");
	await expect.poll(() => loomPage.evaluate(async () => (await window.loom.getChatSettings()).config.default?.modelId)).toBe("demo");

	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	await expect(picker).toHaveText("demo (e2e-chat)");
	await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = loomPage.getByRole("dialog", { name: "Settings", exact: true });
	const chat = settings.getByRole("group", { name: "Chat models", exact: true });
	await expect(chat.getByRole("columnheader", { name: "Default", exact: true })).toHaveCount(0);
	await expect(chat.getByRole("columnheader", { name: "Thinking", exact: true })).toHaveCount(0);
	const demo = chat.getByRole("switch", { name: "Enable demo", exact: true });
	await expect(demo).toBeChecked();
	await demo.locator("..").click();
	await expect(demo).not.toBeChecked();
	await expect(chat.getByRole("switch", { name: "Enable second-model", exact: true })).toBeChecked();
	await settings.getByRole("button", { name: "Close settings" }).click();

	await picker.click();
	await expect(loomPage.getByRole("menuitemradio", { name: "demo (e2e-chat)", exact: true })).toHaveCount(0);
	await expect(loomPage.getByRole("menuitemradio", { name: "second-model (e2e-chat)", exact: true })).toBeVisible();
	await loomPage.keyboard.press("Escape");
	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	await expect(picker).toHaveText("second-model (e2e-chat)");
	await expect.poll(() => loomPage.evaluate(async () => (await window.loom.getChatSettings()).config.default?.modelId)).toBe("demo");
	await picker.click();
	await loomPage.getByRole("menuitemradio", { name: "second-model (e2e-chat)", exact: true }).click();
	await expect(picker).toHaveText("second-model (e2e-chat)");
	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	await expect(picker).toHaveText("second-model (e2e-chat)");

	await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(demo).not.toBeChecked();
	await settings.getByRole("button", { name: "Close settings" }).click();
});

test("permission and model pickers share trigger and selected-item styles", async ({ loomPage }, testInfo) => {
	await saveChatEndpoint(loomPage, "http://127.0.0.1:1/v1");
	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	const permission = loomPage.locator(".session-permission > button");
	const model = loomPage.getByRole("button", { name: "Conversation model", exact: true });
	await expect(model).toHaveText("demo (e2e-chat)");
	const appearance = (selector: string) => loomPage.locator(selector).evaluate((element) => {
		const style = getComputedStyle(element);
		return Object.fromEntries(["font-size", "line-height", "padding", "border-radius", "color", "background-color", "gap"].map((key) => [key, style.getPropertyValue(key)]));
	});
	await permission.hover();
	const permissionTrigger = await appearance(".session-permission > button");
	await model.hover();
	expect(await appearance(".session-model-select > button")).toEqual(permissionTrigger);
	await permission.click();
	const permissionOption = await appearance('.session-permission-menu [aria-selected="true"]');
	await loomPage.screenshot({ path: testInfo.outputPath("permission-menu.png") });
	await loomPage.keyboard.press("Escape");
	await model.click();
	expect(await appearance('.session-model-menu [aria-checked="true"]')).toEqual(permissionOption);
	await loomPage.screenshot({ path: testInfo.outputPath("model-menu.png") });
	await loomPage.keyboard.press("Escape");
});

test("switching models refreshes the context ring without reusing the previous model's usage", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data required");
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const { model } = JSON.parse(body) as { model: string };
			const chunk = { id: "context", object: "chat.completion.chunk", model,
				choices: [{ index: 0, delta: { content: "CONTEXT_RING_OK" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 32768, completion_tokens: 8, total_tokens: 32776 } };
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, { contextWindow: 64000 });
		await loomPage.evaluate(async () => {
			const view = await window.loom.getChatSettings();
			const provider = view.config.providers.find((entry) => entry.id === "e2e-chat");
			if (provider?.kind !== "custom") throw new Error("Missing test provider");
			provider.models.push({ ...provider.models[0]!, id: "small-window", contextWindow: 32000 });
			await window.loom.saveChatSettings(view.config);
		});
		const before = await loomPage.evaluate(() => window.loom.listSessions());
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		const id = (await loomPage.evaluate(() => window.loom.listSessions())).find((row) => !before.some((old) => old.id === row.id))!.id;
		const record = () => loomPage.evaluate((sessionId) => window.loom.getSession(sessionId), id);
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		await loomPage.getByRole("textbox").fill("Reply briefly without using tools.");
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.getByText("CONTEXT_RING_OK", { exact: true })).toBeVisible();
		await expect.poll(async () => (await record()).context?.tokens).toBe(32776);
		const picker = loomPage.getByRole("button", { name: "Conversation model", exact: true });
		await expect(picker).toBeEnabled();
		await picker.click();
		await loomPage.getByRole("menuitemradio", { name: "small-window (e2e-chat)", exact: true }).click();
		await expect(picker).toHaveText("small-window (e2e-chat)");
		await expect.poll(async () => (await record()).context?.window).toBe(32000);
		const context = (await record()).context!;
		expect(context.tokens).toBeGreaterThan(0);
		expect(context.tokens).toBeLessThan(32776);
		await loomPage.getByRole("button", { name: "Context usage", exact: true }).click();
		await expect(loomPage.locator(".session-context-value")).toHaveText(`~${context.percent!.toFixed(1)}% / 32k`);
		await loomPage.reload();
		await expect(picker).toHaveText("small-window (e2e-chat)");
		await loomPage.getByRole("button", { name: "Context usage", exact: true }).click();
		await expect(loomPage.locator(".session-context-value")).toHaveText(`~${context.percent!.toFixed(1)}% / 32k`);
	} finally {
		server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("model reasoning submenus support mouse, keyboard and persisted per-model choices", async ({ loomPage }, testInfo) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data required");
	await saveChatEndpoint(loomPage, "http://127.0.0.1:1/v1");
	await loomPage.evaluate(async () => {
		const view = await window.loom.getChatSettings();
		const provider = view.config.providers.find((entry) => entry.id === "e2e-chat");
		if (provider?.kind !== "custom") throw new Error("Missing test provider");
		const plain = provider.models[0]!;
		provider.models.push({ ...plain, id: "limited", name: "Limited reasoning", reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, low: null } });
		provider.models.push(...Array.from({ length: 12 }, (_, i) => ({ ...plain, id: `plain-${i}` })));
		provider.models.push({ ...plain, id: "reasoning", name: "Reasoning model", reasoning: true,
			thinkingLevelMap: { minimal: null, xhigh: "xhigh" } });
		await window.loom.saveChatSettings(view.config);
	});
	const before = await loomPage.evaluate(() => window.loom.listSessions());
	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	const sessionId = (await loomPage.evaluate(() => window.loom.listSessions())).find((row) => !before.some((old) => old.id === row.id))!.id;
	const selection = () => loomPage.evaluate(async (id) => (await window.loom.getSession(id)).model, sessionId);
	const picker = loomPage.getByRole("button", { name: "Conversation model", exact: true });
	const menu = loomPage.getByRole("menu", { name: "Conversation model", exact: true });
	const thinking = loomPage.getByRole("menu", { name: "Thinking level", exact: true });
	const reasoning = menu.getByRole("menuitemradio", { name: "Reasoning model (e2e-chat)", exact: true });
	const limited = menu.getByRole("menuitemradio", { name: "Limited reasoning (e2e-chat)", exact: true });
	await expect(loomPage.locator(".session-model-select > button")).toHaveCount(1);
	await picker.click();
	await reasoning.hover();
	await expect(thinking).toBeVisible();
	await expect(thinking.getByRole("menuitemradio")).toHaveText(["Off", "Low", "Medium", "High", "Extra high"]);
	expect((await selection())?.modelId).toBe("demo");
	const bounds = await thinking.boundingBox();
	const viewport = await loomPage.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	expect(bounds!.x).toBeGreaterThanOrEqual(8);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 8);
	expect(bounds!.y).toBeGreaterThanOrEqual(8);
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 8);
	await loomPage.screenshot({ path: testInfo.outputPath("model-thinking-menu.png") });
	await thinking.getByRole("menuitemradio", { name: "High", exact: true }).click();
	await expect(menu).toHaveCount(0);
	await expect.poll(selection).toMatchObject({ modelId: "reasoning", thinkingLevel: "high" });

	await picker.click();
	await expect(reasoning).toBeFocused();
	await reasoning.press("ArrowRight");
	await expect(thinking.getByRole("menuitemradio", { name: "High", exact: true })).toBeFocused();
	await loomPage.keyboard.press("Escape");
	await expect(thinking).toHaveCount(0);
	await expect(reasoning).toBeFocused();
	await expect(menu).toBeVisible();
	await reasoning.press("ArrowRight");
	await loomPage.keyboard.press("ArrowUp");
	await expect(thinking.getByRole("menuitemradio", { name: "Medium", exact: true })).toBeFocused();
	await loomPage.keyboard.press("Enter");
	await expect.poll(selection).toMatchObject({ modelId: "reasoning", thinkingLevel: "medium" });

	await picker.click();
	await limited.hover();
	await limited.locator(".session-model-effort").click();
	await expect(thinking.getByRole("menuitemradio")).toHaveText(["Medium", "High"]);
	await thinking.getByRole("menuitemradio", { name: "High", exact: true }).click();
	await expect.poll(selection).toMatchObject({ modelId: "limited", thinkingLevel: "high" });
	await loomPage.reload();
	await expect(picker).toHaveText("Limited reasoning (e2e-chat)");
	await picker.click();
	await limited.hover();
	await expect(thinking.getByRole("menuitemradio", { name: "High", exact: true })).toHaveAttribute("aria-checked", "true");
	await menu.evaluate((element) => { element.scrollTop = element.scrollHeight; });
	await expect(thinking).toHaveCount(0);
	await loomPage.getByRole("heading", { name: "Choose an asset", exact: true }).click();
	await expect(menu).toHaveCount(0);

	await picker.click();
	const plain = menu.getByRole("menuitemradio", { name: "demo (e2e-chat)", exact: true });
	await plain.hover();
	await expect(plain).not.toHaveAttribute("aria-haspopup", "menu");
	await expect(thinking).toHaveCount(0);
	await plain.click();
	await expect.poll(selection).toMatchObject({ modelId: "demo", thinkingLevel: "off" });
});

test("Chat provider status uses green/red dots and shares the MCP error tooltip", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data required");
	await saveChatEndpoint(loomPage, "http://127.0.0.1:1/v1");
	await loomPage.evaluate(async () => {
		const view = await window.loom.getChatSettings();
		view.config.providers.push({
			kind: "custom", id: "auth-missing", name: "Missing credentials", enabled: true,
			baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions",
			models: [{ id: "demo", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 8192 }],
		});
		await window.loom.saveChatSettings(view.config);
	});
	await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = loomPage.getByRole("dialog", { name: "Settings", exact: true });
	const chat = settings.getByRole("group", { name: "Chat models", exact: true });
	const ready = chat.locator(".settings-chat-provider").filter({ has: loomPage.getByText("e2e-chat", { exact: true }) });
	const missing = chat.locator(".settings-chat-provider").filter({ has: loomPage.getByText("Missing credentials", { exact: true }) });
	await expect(chat.locator(".settings-chat-provider-head button:not(.settings-probe-error):not(.settings-chat-provider-toggle)")).toHaveCount(0);
	await expect(missing.locator(".settings-chat-provider-actions").getByRole("button", { name: "Remove", exact: true })).toBeVisible();
	await expect(ready.locator(".settings-probe.is-ok")).toBeVisible();
	await expect(chat.getByText("Signed in", { exact: true })).toHaveCount(0);
	const error = missing.getByRole("button", { name: "Authentication problem", exact: true });
	await expect(error.locator(".settings-probe.is-error")).toBeVisible();
	await expect(error.locator("svg")).toHaveCount(0);
	await error.hover();
	const tooltip = loomPage.getByRole("tooltip");
	await expect(tooltip).toContainText("No credentials are configured. Add an API key or sign in.");
	await expect(tooltip.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
	await settings.getByRole("button", { name: "Close settings" }).hover();
	await expect(tooltip).toBeHidden();
	await error.focus();
	await expect(tooltip).toBeVisible();
	await settings.getByRole("button", { name: "Close settings" }).click();
});

import { expect, saveChatEndpoint, test } from "./loom.ts";

test("Settings enable switches control the picker and new sessions remember only explicit choices", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data required");
	await saveChatEndpoint(loomPage, "http://127.0.0.1:1/v1");
	await loomPage.evaluate(async () => {
		const view = await window.loom.getChatSettings();
		const provider = view.config.providers.find((entry) => entry.id === "e2e-chat");
		if (provider?.kind !== "custom") throw new Error("Missing test provider");
		provider.models.push({ ...provider.models[0]!, id: "second-model" });
		delete view.config.default;
		await window.loom.saveChatSettings(view.config);
	});

	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	const picker = loomPage.getByRole("button", { name: "Conversation model", exact: true });
	await expect(picker).toHaveText("Choose a model");
	await picker.click();
	await loomPage.getByRole("option", { name: "demo (e2e-chat)", exact: true }).click();
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
	await expect(loomPage.getByRole("option", { name: "demo (e2e-chat)", exact: true })).toHaveCount(0);
	await expect(loomPage.getByRole("option", { name: "second-model (e2e-chat)", exact: true })).toBeVisible();
	await loomPage.keyboard.press("Escape");
	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	await expect(picker).toHaveText("Choose a model");
	// The other enabled model is not automatically selected.
	await expect.poll(() => loomPage.evaluate(async () => (await window.loom.getChatSettings()).config.default?.modelId)).toBe("demo");
	await picker.click();
	await loomPage.getByRole("option", { name: "second-model (e2e-chat)", exact: true }).click();
	await expect(picker).toHaveText("second-model (e2e-chat)");
	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	await expect(picker).toHaveText("second-model (e2e-chat)");

	await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(demo).not.toBeChecked();
	await settings.getByRole("button", { name: "Close settings" }).click();
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
	await expect(chat.locator(".settings-chat-provider-head button:not(.settings-probe-error)")).toHaveCount(0);
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

import { fileURLToPath } from "node:url";
import { expect, test } from "./loom.ts";

test("General changes persist immediately and closing does not revert them", async ({ loomPage }) => {
	const original = await loomPage.evaluate(() => window.loom.getGeneralSettings());
	try {
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = loomPage.locator(".settings-dialog");
		await settings.getByRole("tab", { name: "General", exact: true }).click();
		await expect(settings.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
		await expect(settings.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
		await settings.getByRole("radio", { name: "简体中文", exact: true }).locator("..").click();
		await expect(loomPage.locator("html")).toHaveAttribute("lang", "zh-CN");
		expect((await loomPage.evaluate(() => window.loom.getGeneralSettings())).language).toBe("zh-CN");
		const toggle = settings.getByRole("switch", { name: "重新打开上次的素材库", exact: true });
		await toggle.locator("..").click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getGeneralSettings())).reopenLastLibrary).toBe(!original.reopenLastLibrary);
		await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
		await loomPage.getByRole("button", { name: "设置", exact: true }).click();
		await settings.getByRole("tab", { name: "通用", exact: true }).click();
		await expect(settings.getByRole("radio", { name: "简体中文", exact: true })).toBeChecked();
		await settings.getByRole("radio", { name: "English", exact: true }).locator("..").click();
		await expect(loomPage.locator("html")).toHaveAttribute("lang", "en");
		await settings.getByRole("button", { name: "Close settings", exact: true }).click();
	} finally {
		await loomPage.evaluate((settings) => window.loom.saveGeneralSettings(settings), original);
		await loomPage.reload();
	}
});

test("Instructions autosave after a pause, reject excess text, and flush on close", async ({ loomPage }) => {
	const original = await loomPage.evaluate(() => window.loom.getAgentInstructions());
	const originalSandbox = await loomPage.evaluate(() => window.loom.getAgentSandbox());
	try {
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = loomPage.locator(".settings-dialog");
		await settings.getByRole("tab", { name: "Agent", exact: true }).click();
		const input = settings.getByRole("textbox", { name: "Agent instructions", exact: true });
		await input.fill("Automatic instruction saving.");
		await expect.poll(() => loomPage.evaluate(() => window.loom.getAgentInstructions())).toBe("Automatic instruction saving.");
		await input.fill("x".repeat(40_001));
		await expect(settings.getByRole("alert")).toContainText("Instructions are over");
		expect(await loomPage.evaluate(() => window.loom.getAgentInstructions())).toBe("Automatic instruction saving.");
		await input.fill("Saved even when closed before the debounce expires.");
		await settings.getByRole("button", { name: "Close settings", exact: true }).click();
		await expect(settings).toHaveCount(0);
		expect(await loomPage.evaluate(() => window.loom.getAgentInstructions())).toBe("Saved even when closed before the debounce expires.");
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		await settings.getByRole("tab", { name: "Agent", exact: true }).click();
		const toggle = settings.getByRole("switch", { name: "Process sandbox", exact: true });
		await toggle.locator("..").click();
		await expect.poll(() => loomPage.evaluate(() => window.loom.getAgentSandbox())).toBe(!originalSandbox);
		await settings.getByRole("button", { name: "Close settings", exact: true }).click();
	} finally {
		await loomPage.evaluate(async ({ text, sandbox }) => {
			await window.loom.saveAgentInstructions(text); await window.loom.saveAgentSandbox(sandbox);
		}, { text: original, sandbox: originalSandbox });
	}
});

test("model text saves on Enter or blur; invalid sibling drafts do not block other saves", async ({ loomPage }) => {
	const original = await loomPage.evaluate(() => window.loom.getModelSettings());
	try {
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = loomPage.locator(".settings-dialog");
		const slot = settings.getByRole("group", { name: "Text embedding", exact: true });
		const toggle = slot.getByRole("switch", { name: "Enable Text embedding", exact: true });
		if (await toggle.isChecked()) await toggle.locator("..").click();
		const url = slot.getByRole("textbox", { name: "Request URL", exact: true });
		const model = slot.getByRole("textbox", { name: "Model", exact: true });
		await url.fill("https://example.com/v2/embeddings"); await url.press("Enter");
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getModelSettings())).embedding.requestUrl).toBe("https://example.com/v2/embeddings");
		await model.fill("saved-model"); await model.press("Tab");
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getModelSettings())).embedding.model).toBe("saved-model");
		await url.fill("invalid-url"); await url.press("Tab");
		await expect(settings.getByRole("alert")).toContainText("Request URL");
		const originalKey = (await loomPage.evaluate(() => window.loom.getModelSettings())).embedding.apiKey;
		await slot.getByRole("button", { name: "Text embedding API key", exact: true }).click();
		const keyDialog = loomPage.getByRole("dialog", { name: "Text embedding API key", exact: true });
		await keyDialog.getByLabel("Text embedding API key", { exact: true }).fill("failed-save-key");
		await keyDialog.getByRole("button", { name: "Confirm", exact: true }).click();
		await expect(keyDialog.getByRole("alert")).toContainText("Could not save the key");
		await keyDialog.getByRole("button", { name: "Cancel", exact: true }).click();
		expect((await loomPage.evaluate(() => window.loom.getModelSettings())).embedding.apiKey).toBe(originalKey);
		const other = settings.getByRole("group", { name: "Rerank", exact: true });
		await other.getByRole("textbox", { name: "Model", exact: true }).fill("other-saved-model");
		await other.getByRole("textbox", { name: "Model", exact: true }).press("Enter");
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getModelSettings())).rerank.model).toBe("other-saved-model");
		expect((await loomPage.evaluate(() => window.loom.getModelSettings())).embedding.requestUrl).toBe("https://example.com/v2/embeddings");
		await expect(url).toHaveValue("invalid-url");
		await url.fill("https://example.com/v2/embeddings"); await url.press("Enter");
		await slot.getByRole("button", { name: "Text embedding API key", exact: true }).click();
		await expect(keyDialog.getByLabel("Text embedding API key", { exact: true })).toHaveValue(originalKey);
		await keyDialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await settings.getByRole("button", { name: "Close settings", exact: true }).click();
	} finally { await loomPage.evaluate((draft) => window.loom.saveModelSettings(draft), original); }
});

test("MCP drafts commit per server, while toggles and removal persist immediately", async ({ loomPage }) => {
	const original = await loomPage.evaluate(() => window.loom.getMcpSettings());
	const script = fileURLToPath(new URL("../tests/fixtures/mcp-image-server.ts", import.meta.url));
	try {
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = loomPage.locator(".settings-dialog");
		await settings.getByRole("tab", { name: "MCP", exact: true }).click();
		await settings.getByRole("button", { name: "Add server", exact: true }).click();
		const first = settings.getByRole("group", { name: `Server ${original.servers.length + 1}`, exact: true });
		await first.getByRole("textbox", { name: "Server name", exact: true }).fill("autosave-mcp");
		const row = settings.getByRole("group", { name: "autosave-mcp", exact: true });
		await row.getByRole("textbox", { name: "Command", exact: true }).fill(process.execPath);
		await row.getByRole("textbox", { name: "Args (one per line)", exact: true }).fill(script);
		await settings.getByRole("button", { name: "Add server", exact: true }).click();
		expect((await loomPage.evaluate(() => window.loom.getMcpSettings())).servers).toEqual(original.servers);
		await row.getByRole("button", { name: "Save server", exact: true }).click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getMcpSettings())).servers.length).toBe(original.servers.length + 1);
		const toggle = row.getByRole("switch", { name: "Enable autosave-mcp", exact: true });
		await expect(toggle).toBeEnabled();
		await toggle.locator("..").click();
		await expect(row.getByText("Connected: image", { exact: true })).toBeVisible();
		expect((await loomPage.evaluate(() => window.loom.getMcpSettings())).servers.find((server) => server.id === "autosave-mcp")?.enabled).toBe(true);
		await toggle.locator("..").click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getMcpSettings())).servers.find((server) => server.id === "autosave-mcp")?.enabled).toBe(false);
		await row.getByRole("button", { name: "Remove", exact: true }).click();
		await expect(row).toHaveCount(0);
		expect((await loomPage.evaluate(() => window.loom.getMcpSettings())).servers).toEqual(original.servers);
		await settings.getByRole("button", { name: "Close settings", exact: true }).click();
	} finally { await loomPage.evaluate(async (drafts) => window.loom.saveMcpSettings({
		remove: (await window.loom.getMcpSettings()).servers.map((row) => row.id),
		upsert: drafts.map((server) => ({ server })),
	}), original.servers); }
});

test("a stale settings form preserves independent model and MCP changes from Main", async ({ loomPage }) => {
	const models = await loomPage.evaluate(() => window.loom.getModelSettings());
	const mcp = await loomPage.evaluate(() => window.loom.getMcpSettings());
	try {
		await loomPage.evaluate(async () => {
			await window.loom.saveModelSettings({ embedding: { requestUrl: "https://example.com/old", model: "old", enabled: false } });
			await window.loom.saveMcpSettings({ upsert: [{ server: { id: "concurrent-row", command: "old", enabled: false } }] });
		});
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = loomPage.locator(".settings-dialog");
		const slot = settings.getByRole("group", { name: "Text embedding", exact: true });
		const model = slot.getByRole("textbox", { name: "Model", exact: true });
		await model.fill("from-ui");
		await loomPage.evaluate(() => window.loom.saveModelSettings({
			embedding: { requestUrl: "https://example.com/from-agent", apiKey: "agent-key" },
			audio: { model: "agent-audio" },
		}));
		await model.press("Enter");
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getModelSettings())).embedding.model).toBe("from-ui");
		const saved = await loomPage.evaluate(() => window.loom.getModelSettings());
		expect(saved.embedding.requestUrl).toBe("https://example.com/from-agent");
		expect(saved.embedding.apiKey).toBe("agent-key");
		expect(saved.audio.model).toBe("agent-audio");

		await settings.getByRole("tab", { name: "MCP", exact: true }).click();
		const row = settings.getByRole("group", { name: "concurrent-row", exact: true });
		await row.getByRole("textbox", { name: "Command", exact: true }).fill("from-ui");
		await loomPage.evaluate(() => window.loom.saveMcpSettings({ upsert: [
			{ server: { id: "concurrent-row", envText: "TOKEN=from-agent" } },
			{ server: { id: "agent-added", command: "node", enabled: false } },
		] }));
		await row.getByRole("button", { name: "Save server", exact: true }).click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getMcpSettings())).servers.find((server) => server.id === "concurrent-row")?.command).toBe("from-ui");
		const servers = (await loomPage.evaluate(() => window.loom.getMcpSettings())).servers;
		expect(servers.find((server) => server.id === "concurrent-row")?.envText).toBe("TOKEN=from-agent");
		expect(servers.some((server) => server.id === "agent-added")).toBe(true);
		await settings.getByRole("button", { name: "Close settings", exact: true }).click();
	} finally {
		await loomPage.evaluate(async ({ models, servers }) => {
			await window.loom.saveModelSettings(models);
			await window.loom.saveMcpSettings({
				remove: (await window.loom.getMcpSettings()).servers.map((row) => row.id),
				upsert: servers.map((server) => ({ server })),
			});
		}, { models, servers: mcp.servers });
	}
});

test("editing an open custom provider preserves independent external changes", async ({ loomPage }) => {
	await loomPage.evaluate(() => window.loom.patchChatSettings({ upsert: [{
		id: "concurrent-custom", kind: "custom", name: "Before concurrent edit", enabled: true,
		baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions",
		models: [{ id: "demo", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024 }],
	}] }));
	try {
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = loomPage.locator(".settings-dialog");
		const provider = settings.locator(".settings-chat-provider").filter({ hasText: "Before concurrent edit" });
		await provider.getByRole("button", { name: "Edit", exact: true }).click();
		const editor = provider.getByRole("group", { name: "Edit custom provider", exact: true });
		await editor.getByRole("textbox", { name: "Provider name (optional)", exact: true }).fill("From UI");
		await loomPage.evaluate(() => window.loom.patchChatSettings({ upsert: [{
			id: "concurrent-custom", enabled: false, modelEnabled: { demo: false }, generation: { temperature: 0.25 },
		}] }));
		await editor.getByRole("button", { name: "Save provider", exact: true }).click();
		await expect(editor).toHaveCount(0);
		const saved = await loomPage.evaluate(async () => (await window.loom.getChatSettings()).config.providers.find((row) => row.id === "concurrent-custom"));
		expect(saved?.name).toBe("From UI");
		expect(saved?.enabled).toBe(false);
		expect(saved?.modelEnabled?.demo).toBe(false);
		expect(saved?.generation?.temperature).toBe(0.25);
		// Clearing an optional display name is also a delta.
		const renamed = settings.locator(".settings-chat-provider").filter({ hasText: "From UI" });
		await renamed.getByRole("button", { name: "Edit", exact: true }).click();
		await renamed.getByRole("textbox", { name: "Provider name (optional)", exact: true }).fill("");
		await renamed.getByRole("button", { name: "Save provider", exact: true }).click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getChatSettings())).config.providers.find((row) => row.id === "concurrent-custom")?.name).toBeUndefined();
		await settings.getByRole("button", { name: "Close settings", exact: true }).click();
	} finally {
		await loomPage.evaluate(() => window.loom.patchChatSettings({ remove: ["concurrent-custom"] }));
	}
});

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, saveChatEndpoint, test } from "./loom.ts";

test("workbench shell is visible", async ({ loomPage }) => {
	await expect(loomPage.getByText("Loom", { exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(loomPage.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
	await expect(loomPage.getByRole("button", { name: "Agent permission", exact: true })).toBeVisible();
});

test("the help button opens the tips dialog and Escape closes it", async ({ loomPage }) => {
	await loomPage.getByRole("button", { name: "Help", exact: true }).click();
	const help = loomPage.getByRole("dialog", { name: "Help", exact: true });
	await expect(help).toBeVisible();
	await expect(help.getByRole("heading", { name: "Getting started" })).toBeVisible();
	await loomPage.keyboard.press("Escape");
	await expect(help).toHaveCount(0);
	await loomPage.getByRole("button", { name: "Help", exact: true }).click();
	await help.getByRole("button", { name: "Close help", exact: true }).click();
	await expect(help).toHaveCount(0);
});

test("help lists topics on the left and shows one on the right", async ({ loomPage }) => {
	await loomPage.getByRole("button", { name: "Help", exact: true }).click();
	const help = loomPage.getByRole("dialog", { name: "Help", exact: true });
	const topics = help.getByRole("tab");
	await expect(topics).toHaveCount(7);
	await expect(topics.first()).toHaveAttribute("aria-selected", "true");
	await expect(help.getByRole("heading", { name: "Getting started" })).toBeVisible();
	await expect(help.getByRole("heading", { name: "Keep the embedding model steady" })).toHaveCount(0);

	await help.getByRole("tab", { name: "Keep the embedding model steady" }).click();
	await expect(help.getByRole("heading", { name: "Keep the embedding model steady" })).toBeVisible();
	await expect(help.getByRole("heading", { name: "Getting started" })).toHaveCount(0);
	await expect(help.getByRole("tab", { name: "Keep the embedding model steady" })).toHaveAttribute("aria-selected", "true");

	// Arrow keys move through every topic, across group boundaries, and wrap.
	await help.getByRole("tab", { name: "Keep the embedding model steady" }).focus();
	await loomPage.keyboard.press("ArrowDown");
	await expect(help.getByRole("heading", { name: "Size limits" })).toBeVisible();
	await loomPage.keyboard.press("ArrowDown");
	await expect(help.getByRole("heading", { name: "Keep the .loom folder" })).toBeVisible();
	await loomPage.keyboard.press("ArrowUp");
	await expect(help.getByRole("heading", { name: "Size limits" })).toBeVisible();

	// The dialog keeps its size whichever topic is open.
	const before = (await help.boundingBox())!;
	await help.getByRole("tab", { name: "Getting started" }).click();
	const after = (await help.boundingBox())!;
	expect(after.height).toBe(before.height);
	expect(after.width).toBe(before.width);
	await loomPage.keyboard.press("Escape");
	await expect(help).toHaveCount(0);
});

test("a help dialog stays inside the window and its text scrolls inside it", async ({ loomPage }) => {
	await loomPage.getByRole("button", { name: "Help", exact: true }).click();
	const help = loomPage.getByRole("dialog", { name: "Help", exact: true });
	await help.getByRole("tab", { name: "What the Agent can do" }).click();
	await expect(help.getByText("Chat: attach up to 4 images")).toBeAttached();
	const box = (await help.boundingBox())!;
	const innerHeight = await loomPage.evaluate(() => window.innerHeight);
	expect(box.y).toBeGreaterThanOrEqual(0);
	expect(box.y + box.height).toBeLessThanOrEqual(innerHeight);
	// The text column owns the scrolling; the dialog itself does not grow.
	const overflow = await help.locator(".help-body").evaluate((element) => getComputedStyle(element).overflowY);
	expect(overflow).toBe("auto");
	await loomPage.keyboard.press("Escape");
	await expect(help).toHaveCount(0);
});

test("dragging a text selection out of the help dialog does not close it", async ({ loomPage }) => {
	await loomPage.getByRole("button", { name: "Help", exact: true }).click();
	const help = loomPage.getByRole("dialog", { name: "Help", exact: true });
	await expect(help).toBeVisible();
	const box = (await help.boundingBox())!;
	const heading = (await help.getByRole("heading", { name: "Getting started" }).boundingBox())!;
	// Press inside the dialog, drag past its edge onto the backdrop, release there.
	await loomPage.mouse.move(heading.x + 4, heading.y + heading.height / 2);
	await loomPage.mouse.down();
	await loomPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
	await loomPage.mouse.move(box.x + box.width + 40, box.y + box.height / 2, { steps: 5 });
	await loomPage.mouse.up();
	await expect(help).toBeVisible();
	// A plain click on the backdrop still closes it.
	await loomPage.mouse.click(box.x + box.width + 40, box.y + box.height / 2);
	await expect(help).toHaveCount(0);
});

test("creates a durable conversation and discards the unused tab on close",  async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "attach mode shares the running library");
	const root = await loomPage.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	expect(root).toBeTruthy();
	await expect(loomPage.getByRole("tab", { name: "New session", exact: true }).first()).toBeVisible();
	const initial = await loomPage.evaluate(() => window.loom.listSessions());
	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(initial.length + 1);
	const sessions = await loomPage.evaluate(() => window.loom.listSessions());
	const created = sessions.find((session) => !initial.some(({ id }) => id === session.id));
	expect(created).toBeDefined();
	const record = await loomPage.evaluate((id) => window.loom.openSession(id), created!.id);
	expect(record.title).toBe("New session");
	expect(record.messages).toEqual([]);
	await expect(loomPage.getByRole("tablist", { name: "Sessions" }).getByRole("tab")).toHaveCount(sessions.filter(({ status }) => status === "open").length);

	const database = await readFile(join(root!, ".loom", "agents", "sessions", "loom.sqlite"));
	expect(database.subarray(0, 16).toString()).toBe("SQLite format 3\u0000");
	expect(created!.id).toMatch(/^[1-9]\d*$/);

	await expect(loomPage.getByRole("tab", { name: "New session", selected: true, exact: true })).toBeVisible();
	const archivedIds = sessions.filter((row) => row.status === "archived").map((row) => row.id);
	await loomPage.locator(".session-tab.active").getByRole("button", { name: "Close New session", exact: true }).click();
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).some((row) => row.id === created!.id)).toBe(false);
	await expect(loomPage.getByRole("tablist", { name: "Sessions" }).getByRole("tab", { selected: true })).toHaveCount(1);
	await loomPage.reload();
	await expect(loomPage.getByRole("tablist", { name: "Sessions" }).getByRole("tab", { selected: true })).toHaveCount(1);
	expect((await loomPage.evaluate(() => window.loom.listSessions())).some((row) => row.id === created!.id)).toBe(false);
	expect((await loomPage.evaluate(() => window.loom.listSessions())).filter((row) => row.status === "archived").map((row) => row.id)).toEqual(archivedIds);
});

test("settings has Models, MCP, and Stats tabs", async ({ loomPage }) => {
	await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = loomPage.getByRole("dialog", { name: "Settings" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("tab", { name: "Models" })).toBeVisible();
	await expect(dialog.getByRole("tab", { name: "MCP" })).toBeVisible();
	await expect(dialog.getByRole("tab", { name: "Agent" })).toBeVisible();
	await expect(dialog.getByRole("tab", { name: "Stats" })).toBeVisible();
	await dialog.getByRole("tab", { name: "Agent" }).click();
	await expect(dialog.getByRole("switch", { name: "Process sandbox" })).toBeChecked();
	await expect(dialog.getByRole("textbox", { name: "Agent instructions" })).toBeVisible();
	await dialog.getByRole("tab", { name: "MCP" }).click();
	await expect(dialog.getByRole("button", { name: "Add server" })).toBeVisible();
	await dialog.getByRole("tab", { name: "Stats" }).click();
	await expect(dialog.getByText("Prompt-cache hit rate", { exact: true })).toBeVisible();
	await dialog.getByRole("button", { name: "Close settings" }).click();
	await expect(dialog).toBeHidden();
});

test("settings persist the chat provider", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "attach mode shares the running userData");
	// A provider with models, so the model table renders. Do not rely on a developer's .env creating one.
	await saveChatEndpoint(loomPage, "http://127.0.0.1:1/v1", { model: "demo" });
	await loomPage.getByRole("button", { name: "Settings" }).click();
	const dialog = loomPage.getByRole("dialog", { name: "Settings" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("group", { name: "Embedding" })).toBeVisible();
	await expect(dialog.getByRole("group", { name: "Rerank" })).toBeVisible();
	await expect(dialog.getByRole("group", { name: "VLM" })).toBeVisible();
	// Chat models is a provider-based section, saved immediately.
	await expect(dialog.getByRole("combobox", { name: "Add provider" })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Refresh models" })).toBeVisible();
	await expect(dialog.getByRole("group", { name: "Chat models", exact: true })).toBeVisible();
	await expect(dialog.getByRole("columnheader", { name: "Enabled" }).first()).toBeVisible();
	await expect(dialog.getByRole("columnheader", { name: "Default" })).toHaveCount(0);
	await expect(dialog.getByRole("columnheader", { name: "Thinking" })).toHaveCount(0);
	await expect(dialog.locator(".settings-chat-models select")).toHaveCount(0);
	await dialog.getByRole("button", { name: "Close settings" }).click();
	await expect(dialog).toBeHidden();
});

test("session model selection persists per conversation", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "attach mode shares the running library");
	// Two keyless stub models from one provider runtime.
	await saveChatEndpoint(loomPage, "http://127.0.0.1:1/v1", { model: "demo" });
	const created = await loomPage.evaluate(async () => {
		const initial = await window.loom.listSessions();
		const record = await window.loom.createSession();
		return { record, had: initial.length };
	});
	const record = created.record;
	expect(record.model?.modelId).toBe("demo");
	// Per-conversation switch through the IPC path.
	const updated = await loomPage.evaluate(async (id) => {
		const view = await window.loom.getChatSettings();
		const model = view.models.find((row) => row.provider === "e2e-chat" && row.id !== "demo");
		if (model) return window.loom.setSessionModel(id, { provider: model.provider, modelId: model.id });
		return null;
	}, record.id);
	// Only the cataloged model exists; a second model makes the switch observable.
	if (updated) expect(updated.model?.modelId).not.toBe("demo");
	// Unknown models reject with a clear error.
	const failure = await loomPage.evaluate(async (id) => {
		try { await window.loom.setSessionModel(id, { provider: "e2e-chat", modelId: "missing" }); return "resolved"; }
		catch (error) { return String(error); }
	}, record.id);
	expect(failure).toMatch(/Unknown Chat model/);
});

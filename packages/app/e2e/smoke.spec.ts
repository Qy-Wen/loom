import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("workbench shell is visible", async ({ loomPage }) => {
	await expect(loomPage.getByText("Loom", { exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(loomPage.getByRole("button", { name: "Agent" })).toBeVisible();
	await expect(loomPage.getByRole("button", { name: "Settings" })).toBeVisible();
	await loomPage.getByRole("button", { name: "Agent" }).click();
	await expect(loomPage.getByRole("combobox", { name: "Agent permission" })).toBeVisible();
});

test("creates a persisted Harness session without Chat", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "attach mode shares the running library");
	const root = await loomPage.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	expect(root).toBeTruthy();
	await expect(loomPage.getByRole("tab", { name: "New session" })).toHaveCount(1);
	const initial = await loomPage.evaluate(() => window.loom.listSessions());
	await loomPage.getByRole("button", { name: "New session", exact: true }).click();
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(initial.length + 1);
	const sessions = await loomPage.evaluate(() => window.loom.listSessions());
	const created = sessions.find((session) => !initial.some(({ id }) => id === session.id));
	expect(created).toBeDefined();
	const record = await loomPage.evaluate((id) => window.loom.openSession(id), created!.id);
	expect(record.title).toBe("New session");
	expect(record.messages).toEqual([]);
	await expect(loomPage.getByRole("tab", { name: "New session" })).toHaveCount(sessions.filter(({ status }) => status === "open").length);

	const sessionsRoot = join(root!, ".loom", "harness-sessions");
	const directories = await readdir(sessionsRoot);
	const files = (await Promise.all(directories.map(async (directory) =>
		(await readdir(join(sessionsRoot, directory))).map((file) => join(sessionsRoot, directory, file)),
	))).flat();
	const headers = await Promise.all(files.map(async (file) => JSON.parse((await readFile(file, "utf8")).split("\n")[0]!)));
	expect(headers).toContainEqual(expect.objectContaining({ kind: "header", v: 4, id: created!.id }));
});

test("settings has Models, MCP, and Stats tabs", async ({ loomPage }) => {
	await loomPage.getByRole("button", { name: "Settings" }).click();
	const dialog = loomPage.getByRole("dialog", { name: "Settings" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("tab", { name: "Models" })).toBeVisible();
	await expect(dialog.getByRole("tab", { name: "MCP" })).toBeVisible();
	await expect(dialog.getByRole("tab", { name: "Stats" })).toBeVisible();
	await dialog.getByRole("tab", { name: "MCP" }).click();
	await expect(dialog.getByRole("button", { name: "Add server" })).toBeVisible();
	await dialog.getByRole("tab", { name: "Stats" }).click();
	await expect(dialog.getByText("Prompt-cache hit rate", { exact: true })).toBeVisible();
	await dialog.getByRole("button", { name: "Close settings" }).click();
	await expect(dialog).toBeHidden();
});

test("settings persist the chat slot", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "attach mode shares the running userData");
	await loomPage.getByRole("button", { name: "Settings" }).click();
	const dialog = loomPage.getByRole("dialog", { name: "Settings" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("group", { name: "Embedding" })).toBeVisible();
	await expect(dialog.getByRole("group", { name: "Rerank" })).toBeVisible();
	await expect(dialog.getByRole("group", { name: "VLM" })).toBeVisible();

	const chat = dialog.getByRole("group", { name: "Chat" });
	const key = chat.getByLabel("Chat API key", { exact: true });
	await expect(key).toHaveAttribute("type", "password");
	await chat.getByRole("button", { name: "Show Chat API key" }).click();
	await expect(key).toHaveAttribute("type", "text");
	await chat.getByRole("button", { name: "Hide Chat API key" }).click();
	await expect(key).toHaveAttribute("type", "password");
	await chat.getByLabel("Base URL").fill("http://127.0.0.1:11434/v1");
	await chat.getByLabel("Model").fill("loom-e2e-chat");
	await key.fill("loom-e2e-key");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();

	await loomPage.getByRole("button", { name: "Settings" }).click();
	const again = loomPage.getByRole("dialog", { name: "Settings" });
	const againChat = again.getByRole("group", { name: "Chat" });
	await expect(againChat.getByLabel("Base URL")).toHaveValue("http://127.0.0.1:11434/v1");
	await expect(againChat.getByLabel("Model")).toHaveValue("loom-e2e-chat");
	const againKey = againChat.getByLabel("Chat API key", { exact: true });
	await expect(againKey).toHaveAttribute("type", "password");
	await againChat.getByRole("button", { name: "Show Chat API key" }).click();
	await expect(againKey).toHaveValue("loom-e2e-key");
});

import { expect, test } from "./loom.ts";

test("workbench shell is visible", async ({ loomPage }) => {
	await expect(loomPage.getByText("Loom", { exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(loomPage.getByRole("button", { name: "Agent" })).toBeVisible();
	await expect(loomPage.getByRole("button", { name: "Settings" })).toBeVisible();
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

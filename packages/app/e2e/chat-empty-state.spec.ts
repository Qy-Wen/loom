import { expect, saveChatEndpoint, test } from "./loom.ts";

test("an empty conversation points to Settings when no model is usable", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data required");
	const empty = loomPage.getByTestId("chat-empty");
	await expect(empty).toContainText("Connect a model to start chatting");
	await empty.getByRole("button", { name: "Open Settings", exact: true }).click();
	await expect(loomPage.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
});

test("suggestions fill the composer without sending and never overwrite a draft", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data required");
	await saveChatEndpoint(loomPage, "http://127.0.0.1:1/v1");
	const empty = loomPage.getByTestId("chat-empty");
	const suggestions = empty.locator(".chat-empty-suggestion");
	await expect(suggestions).toHaveCount(3);
	const editor = loomPage.getByTestId("copilot-chat-textarea");
	const [first, second] = [await suggestions.nth(0).innerText(), await suggestions.nth(1).innerText()];

	await suggestions.nth(0).click();
	await expect(editor).toContainText(first);
	await expect(editor).toBeFocused();
	// Nothing was sent: the conversation is still empty.
	await expect(empty).toBeVisible();

	await suggestions.nth(1).click();
	await expect(editor).toContainText(first);
	await expect(editor).not.toContainText(second);
});

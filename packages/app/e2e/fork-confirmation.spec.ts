import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, saveChatEndpoint, test } from "./loom.ts";

test("branching from a reply asks for confirmation and keeps the source and the composer draft", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated settings and library required");
	let requests = 0;
	const server = createServer((_request, response) => {
		requests++;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end('data: {"id":"fork","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":"FORK_CONFIRM_REPLY"},"finish_reason":null}]}\n\ndata: {"id":"fork","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		await loomPage.getByRole("textbox").fill("FORK_CONFIRM_QUESTION");
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.getByText("FORK_CONFIRM_REPLY", { exact: true })).toBeVisible();
		await expect(loomPage.getByRole("button", { name: "Conversation model", exact: true })).toBeEnabled();
		const before = await loomPage.evaluate(() => window.loom.listSessions());
		const source = before.find((row) => row.title === "FORK_CONFIRM_QUESTION")!;
		const original = await loomPage.evaluate((id) => window.loom.getSession(id), source.id);
		await loomPage.getByRole("textbox").fill("UNSENT_DRAFT");
		const question = loomPage.getByTestId("copilot-user-message").filter({ hasText: "FORK_CONFIRM_QUESTION" });
		// Branching lives on the reply, not on the question.
		await question.hover();
		await expect(question.getByRole("button", { name: "Branch from here", exact: true })).toHaveCount(0);
		const answer = loomPage.getByTestId("copilot-assistant-message").filter({ hasText: "FORK_CONFIRM_REPLY" });
		const fork = answer.getByRole("button", { name: "Branch from here", exact: true });
		for (const approved of [false, true]) {
			await answer.hover();
			await fork.click();
			const dialog = loomPage.getByRole("dialog", { name: "Create a conversation branch?", exact: true });
			await expect(dialog).toBeVisible();
			await expect(dialog).toContainText("A new conversation will include the history up to this reply. The current conversation will be kept.");
			await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
			if (approved) await dialog.getByRole("button", { name: "Create branch", exact: true }).click();
			else await loomPage.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);
			if (!approved) {
				expect(await loomPage.evaluate(() => window.loom.listSessions())).toEqual(before);
				await expect(loomPage.getByRole("tab", { name: source.title, selected: true, exact: true })).toBeVisible();
				await expect(loomPage.getByRole("textbox")).toHaveText("UNSENT_DRAFT");
			}
		}
		await expect(loomPage.getByRole("tab", { name: `${source.title}（分支）`, selected: true, exact: true })).toBeVisible();
		// The branch keeps the whole exchange and starts with an empty composer.
		await expect(loomPage.getByText("FORK_CONFIRM_REPLY", { exact: true })).toBeVisible();
		await expect(loomPage.getByTestId("copilot-user-message").filter({ hasText: "FORK_CONFIRM_QUESTION" })).toBeVisible();
		await expect(loomPage.getByRole("textbox")).toHaveText("");
		const after = await loomPage.evaluate(() => window.loom.listSessions());
		expect(after).toHaveLength(before.length + 1);
		expect((await loomPage.evaluate((id) => window.loom.getSession(id), source.id))).toEqual(original);
		expect(requests).toBe(1);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

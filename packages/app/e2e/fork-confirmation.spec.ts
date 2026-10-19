import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, saveChatEndpoint, test } from "./loom.ts";

test("fork asks for confirmation before creating a branch or replacing the composer draft", async ({ loomPage }) => {
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
		const fork = question.getByRole("button", { name: "Fork", exact: true });
		for (const approved of [false, true]) {
			await question.hover();
			const shown = loomPage.waitForEvent("dialog");
			const click = fork.click();
			const dialog = await shown;
			expect(dialog.type()).toBe("confirm");
			expect(dialog.message()).toBe("Create a new conversation from before this message? The current conversation will be kept.");
			if (approved) await dialog.accept(); else await dialog.dismiss();
			await click;
			if (!approved) {
				expect(await loomPage.evaluate(() => window.loom.listSessions())).toEqual(before);
				await expect(loomPage.getByRole("tab", { name: source.title, selected: true, exact: true })).toBeVisible();
				await expect(loomPage.getByRole("textbox")).toHaveText("UNSENT_DRAFT");
			}
		}
		await expect(loomPage.getByRole("tab", { name: `${source.title}（分支）`, selected: true, exact: true })).toBeVisible();
		await expect(loomPage.getByRole("textbox")).toHaveText("FORK_CONFIRM_QUESTION");
		const after = await loomPage.evaluate(() => window.loom.listSessions());
		expect(after).toHaveLength(before.length + 1);
		expect((await loomPage.evaluate((id) => window.loom.getSession(id), source.id))).toEqual(original);
		expect(requests).toBe(1);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

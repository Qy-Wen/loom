import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, saveChatEndpoint, test } from "./loom.ts";

test("a lone empty session has no close button; it appears with a second session or once there are messages", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "attach mode shares the running library");
	const list = () => loomPage.evaluate(() => window.loom.listSessions());
	const tabs = loomPage.getByRole("tablist", { name: "Sessions" }).getByRole("tab");
	const closeButtons = loomPage.locator(".session-tab-close");
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "close", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(chunk({ content: "CLOSE_BUTTON_REPLY" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
	const initial = await list();
	const before = new Set(initial.map((session) => session.id));
	try {
		// Park every open session. The panel then opens one fresh, empty session of its own.
		for (const session of (await list()).filter((item) => item.status === "open")) {
			await loomPage.evaluate((id) => window.loom.archiveSession(id), session.id);
		}
		await loomPage.reload();
		await expect(tabs).toHaveCount(1);
		await expect(closeButtons).toHaveCount(0);

		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect(tabs).toHaveCount(2);
		await expect(closeButtons).toHaveCount(2);

		// Back to one empty session: the button goes away again.
		await closeButtons.first().click();
		await expect(tabs).toHaveCount(1);
		await expect(closeButtons).toHaveCount(0);

		// A lone session with messages can still be put away, so the button stays.
		await loomPage.getByRole("textbox").fill("CLOSE_BUTTON_QUESTION");
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.getByText("CLOSE_BUTTON_REPLY", { exact: true })).toBeVisible();
		await expect(tabs).toHaveCount(1);
		await expect(closeButtons).toHaveCount(1);
	} finally {
		for (const session of (await list()).filter((item) => !before.has(item.id))) {
			await loomPage.evaluate((id) => window.loom.deleteSession(id), session.id);
		}
		for (const session of initial.filter((item) => item.status === "open")) {
			await loomPage.evaluate((id) => window.loom.unarchiveSession(id), session.id);
		}
		await loomPage.reload();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

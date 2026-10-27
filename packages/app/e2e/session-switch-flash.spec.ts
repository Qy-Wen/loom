import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, saveChatEndpoint, test } from "./loom.ts";

const CURSOR = '[data-testid="copilot-loading-cursor"]';

test("the running dot does not flash when sessions are created, switched, or closed, but shows during a real run", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "attach mode shares the running library");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "flash", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			void gate.then(() => response.end(chunk({ content: "FLASH_REPLY" }, null) + chunk({}, "stop") + "data: [DONE]\n\n"));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const list = () => loomPage.evaluate(() => window.loom.listSessions());
	const before = new Set((await list()).map((session) => session.id));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await loomPage.reload();
		await expect(loomPage.getByRole("tablist", { name: "Sessions" }).getByRole("tab").first()).toBeVisible();
		await loomPage.evaluate((selector) => {
			const scope = window as typeof window & { cursorAdds?: number };
			scope.cursorAdds = 0;
			new MutationObserver((records) => {
				for (const record of records) for (const node of record.addedNodes) {
					if (node instanceof Element && (node.matches(selector) || node.querySelector(selector))) scope.cursorAdds!++;
				}
			}).observe(document.body, { childList: true, subtree: true });
		}, CURSOR);
		const adds = () => loomPage.evaluate(() => (window as typeof window & { cursorAdds?: number }).cursorAdds ?? 0);
		const settle = () => loomPage.waitForTimeout(600);

		const create = loomPage.getByRole("button", { name: "New session", exact: true });
		await create.click(); await settle();
		await create.click(); await settle();
		await loomPage.locator(".session-tab").first().getByRole("tab").click(); await settle();
		await loomPage.locator(".session-tab").last().getByRole("tab").click(); await settle();
		await loomPage.locator(".session-tab.active .session-tab-close").click(); await settle();
		expect(await adds()).toBe(0);

		// A real run still shows it.
		await loomPage.getByRole("textbox").fill("FLASH_QUESTION");
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.locator(CURSOR)).toBeVisible();
		release();
		await expect(loomPage.getByText("FLASH_REPLY", { exact: true })).toBeVisible();
		await expect(loomPage.locator(CURSOR)).toHaveCount(0);
	} finally {
		release();
		for (const session of (await list()).filter((item) => !before.has(item.id))) {
			await loomPage.evaluate((id) => window.loom.deleteSession(id), session.id);
		}
		await loomPage.reload();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

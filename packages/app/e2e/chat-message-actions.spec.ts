import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, saveChatEndpoint, test } from "./loom.ts";

const REPLY = "Here is a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.";
/** The text above the copy button leaves a small gap, not the typography's 20px bottom margin. */
const MAX_GAP_ABOVE_COPY = 8;

test("a reply's table actions sit under the table and match the message copy button", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: object, finish: string | null, usage?: object) => `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
			response.end(chunk({ content: REPLY }, null) + chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) + "data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBeGreaterThan(0);
		await loomPage.getByRole("textbox").fill("a table please");
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.getByText("Done.", { exact: true })).toBeVisible({ timeout: 20_000 });

		const table = loomPage.locator('[data-streamdown="table-wrapper"] table');
		const copyTable = loomPage.locator('button[data-tooltip="Copy table as markdown"]');
		const downloadTable = loomPage.locator('button[data-tooltip="Download table"]');
		const messageCopy = loomPage.locator('[data-testid="copilot-copy-button"]');
		await expect(copyTable).toBeVisible();
		await expect(messageCopy).toBeVisible();
		await messageCopy.hover();
		const tooltip = loomPage.getByRole("tooltip");
		await expect(tooltip).toBeVisible({ timeout: 500 });
		await expect(tooltip).toHaveClass("tooltip");
		await expect(tooltip).toHaveCount(1);
		await copyTable.hover();
		await expect(tooltip).toHaveText("Copy table as markdown", { timeout: 500 });
		await expect(copyTable).not.toHaveAttribute("title");
		await loomPage.keyboard.press("Escape");
		await expect(tooltip).toHaveCount(0);
		const [tableBox, copyBox, downloadBox, messageBox] = [table, copyTable, downloadTable, messageCopy].map((locator) => locator.boundingBox());
		const [t, c, d, m] = [(await tableBox)!, (await copyBox)!, (await downloadBox)!, (await messageBox)!];

		// Same size as the message's own copy button, sitting under the table at its left edge.
		expect([c.width, c.height]).toEqual([26, 26]);
		expect([m.width, m.height]).toEqual([26, 26]);
		expect([d.width, d.height]).toEqual([c.width, c.height]);
		for (const button of [copyTable, downloadTable, messageCopy]) {
			const icon = (await button.locator("svg").boundingBox())!;
			expect([icon.width, icon.height]).toEqual([14, 14]);
			await expect(button).toHaveCSS("margin-bottom", "0px");
		}
		await expect(loomPage.locator('[data-streamdown="table-wrapper"]')).toHaveCSS("margin-bottom", "0px");
		await expect(loomPage.locator('[data-testid="copilot-assistant-toolbar"]')).toHaveCSS("margin-bottom", "0px");
		const userMessage = loomPage.locator('[data-testid="copilot-user-message"]');
		await userMessage.hover();
		const userCopy = userMessage.locator('[data-testid="copilot-user-copy-button"]');
		const userBox = (await userCopy.boundingBox())!;
		expect([userBox.width, userBox.height]).toEqual([26, 26]);
		const userIcon = (await userCopy.locator("svg").boundingBox())!;
		expect([userIcon.width, userIcon.height]).toEqual([14, 14]);
		await expect(userMessage.locator('[data-testid="copilot-user-toolbar"]')).toHaveCSS("margin-bottom", "0px");
		expect(c.y).toBeGreaterThanOrEqual(t.y + t.height);
		expect(Math.abs(c.x - t.x)).toBeLessThan(1);
		expect(d.x).toBeGreaterThan(c.x + c.width - 1);

		// Hover gives the same background as the message's copy button.
		const background = (locator: typeof copyTable) => locator.evaluate((element) => getComputedStyle(element).backgroundColor);
		await messageCopy.hover();
		// Both fade in, so wait for the colour to settle.
		await expect.poll(() => background(messageCopy)).toBe("rgb(232, 232, 232)");
		await copyTable.hover();
		await expect.poll(() => background(copyTable)).toBe("rgb(232, 232, 232)");

		// The download menu is on top of the table and inside the chat.
		await downloadTable.click();
		const csv = loomPage.getByRole("button", { name: "CSV", exact: true });
		await expect(csv).toBeVisible();
		const menu = (await csv.boundingBox())!;
		expect(menu.y + menu.height).toBeLessThanOrEqual(d.y + 1);
		expect(await csv.evaluate((element) => document.elementFromPoint(element.getBoundingClientRect().left + 4, element.getBoundingClientRect().top + 4) === element)).toBe(true);

		// The copy button sits close under the last line of the reply.
		const gap = await loomPage.evaluate(() => {
			const done = [...document.querySelectorAll("p")].find((paragraph) => paragraph.textContent === "Done.")!;
			const button = document.querySelector('[data-testid="copilot-copy-button"]')!;
			return button.getBoundingClientRect().top - done.getBoundingClientRect().bottom;
		});
		expect(gap).toBeLessThanOrEqual(MAX_GAP_ABOVE_COPY);

		// The message copy button's hover background is not clipped on the left.
		const clipLeft = await loomPage.evaluate(() => document.querySelector(".session-chat-scroll")!.getBoundingClientRect().left);
		expect(m.x).toBeGreaterThanOrEqual(clipLeft - 0.5);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, saveChatEndpoint, test } from "./loom.ts";

const REPLY = "Here is a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.";
const CODE_FENCE = `\`\`\`ts\nconst answer = 42;\nconst longLine = "${"a".repeat(160)}";\n\`\`\``;
const CODE_REPLY = `Here is code for \`pi.compaction\`:\n\n${CODE_FENCE}\n\nDone.`;
/** The text above the copy button leaves a small gap, not the typography's 20px bottom margin. */
const MAX_GAP_ABOVE_COPY = 8;

test("a reply's table actions sit under the table and match the message copy button", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	await loomPage.emulateMedia({ colorScheme: "light" });
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
		const messageCopy = loomPage.locator('[data-testid="chat-copy-button"]');
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
		await expect(loomPage.locator('[data-testid="chat-assistant-toolbar"]')).toHaveCSS("margin-bottom", "0px");
		const userMessage = loomPage.locator('[data-testid="chat-user-message"]');
		const userBubble = userMessage.locator(".agui-chat-bubble");
		await expect(userBubble).toHaveCSS("background-color", "rgb(247, 247, 245)");
		await userMessage.hover();
		const userCopy = userMessage.locator('[data-testid="chat-user-copy-button"]');
		const userBox = (await userCopy.boundingBox())!;
		expect([userBox.width, userBox.height]).toEqual([26, 26]);
		const userIcon = (await userCopy.locator("svg").boundingBox())!;
		expect([userIcon.width, userIcon.height]).toEqual([14, 14]);
		await expect(userMessage.locator('[data-testid="chat-user-toolbar"]')).toHaveCSS("margin-bottom", "0px");
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
			const button = document.querySelector('[data-testid="chat-copy-button"]')!;
			return button.getBoundingClientRect().top - done.getBoundingClientRect().bottom;
		});
		expect(gap).toBeLessThanOrEqual(MAX_GAP_ABOVE_COPY);

		// The message copy button's hover background is not clipped on the left.
		const clipLeft = await loomPage.evaluate(() => document.querySelector(".agui-chat-viewport")!.getBoundingClientRect().left);
		expect(m.x).toBeGreaterThanOrEqual(clipLeft - 0.5);

		await loomPage.emulateMedia({ colorScheme: "dark" });
		await expect(userBubble).toHaveCSS("background-color", "rgb(53, 53, 51)");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("reply and reasoning code blocks share readable styling and actions below the code", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	await loomPage.emulateMedia({ colorScheme: "light" });
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: object, finish: string | null, usage?: object) => `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
			response.end(
				chunk({ reasoning_content: `Considering this code:\n\n${CODE_FENCE}` }, null)
				+ chunk({ content: CODE_REPLY }, null)
				+ chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
				+ "data: [DONE]\n\n",
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBeGreaterThan(0);
		await loomPage.getByRole("textbox").fill("some code please");
		await loomPage.getByRole("textbox").press("Enter");
		await expect(loomPage.getByText("Done.", { exact: true })).toBeVisible({ timeout: 20_000 });
		const inlineCode = loomPage.locator('[data-streamdown="inline-code"]').filter({ hasText: /^pi\.compaction$/ });
		await expect(inlineCode).toHaveCSS("background-color", "rgb(240, 240, 237)");

		const reasoningToggle = loomPage.getByRole("button", { name: "Reasoning", exact: true });
		await expect(reasoningToggle).toHaveAttribute("aria-expanded", "false");
		await reasoningToggle.click();
		const reasoningText = loomPage.getByText("Considering this code:", { exact: true });
		await expect(reasoningText).toHaveCSS("color", "rgb(99, 102, 107)");
		const messages = [loomPage.getByTestId("chat-assistant-message"), reasoningToggle.locator("..")];
		for (const message of messages) {
			// Both themes are in the DOM. Only the one that matches the app is shown.
			await expect(message.locator("[data-code-block]")).toHaveCount(2);
			const block = message.locator("[data-code-block]:visible");
			await expect(block).toHaveCount(1);
			await expect(block.locator(".line").first()).toHaveText("const answer = 42;");
			await expect(block).toHaveCSS("background-color", "rgb(240, 240, 237)");
			await expect(block.getByText("const", { exact: true }).first()).toHaveCSS("color", "rgb(215, 58, 73)");
			const source = block.locator("pre");
			await expect(source).toHaveCSS("overflow-x", "auto");
			expect(await source.evaluate((pre) => pre.scrollWidth > pre.clientWidth)).toBe(true);

			const lang = message.locator("[data-code-block-header] > span");
			const copy = message.locator("[data-code-block-header] > div > button").nth(1);
			const download = message.locator('button[data-tooltip="Download file"]');
			await expect(lang).toHaveText("ts");
			await expect(download).toBeVisible();
			const [code, label, line, copyButton, downloadButton] = await Promise.all(
				[block, lang, block.locator(".line").first(), copy, download].map(async (locator) => (await locator.boundingBox())!),
			);

			expect([copyButton.width, copyButton.height]).toEqual([26, 26]);
			expect([downloadButton.width, downloadButton.height]).toEqual([26, 26]);
			expect(label.y).toBeGreaterThanOrEqual(code.y);
			expect(label.y + label.height).toBeLessThanOrEqual(line.y + 1);
			expect(copyButton.y).toBeGreaterThanOrEqual(code.y + code.height);
			expect(Math.abs(copyButton.x - code.x)).toBeLessThan(1);
			expect(downloadButton.x).toBeGreaterThan(copyButton.x + copyButton.width - 1);
		}

		await loomPage.emulateMedia({ colorScheme: "dark" });
		await expect(loomPage.locator("html")).toHaveAttribute("data-theme", "dark");
		await expect(inlineCode).toHaveCSS("background-color", "rgb(53, 53, 51)");
		await expect(reasoningText).toHaveCSS("color", "rgb(163, 163, 159)");
		for (const message of messages) {
			const block = message.locator("[data-code-block]:visible");
			await expect(block).toHaveCount(1);
			await expect(block).toHaveClass(/\bdark:block\b/);
			await expect(block).toHaveCSS("background-color", "rgb(18, 18, 17)");
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

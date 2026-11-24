import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, saveChatEndpoint, test } from "./loom.ts";

test("streaming chat follows the bottom, pauses while reading, and resumes from Latest", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	const next = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const paragraphs = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, index) => `Paragraph ${start + index}.`).join("\n\n");
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (content: string, finishReason: string | null = null) => `data: ${JSON.stringify({ id: "scroll", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`;
			response.write(chunk(paragraphs(1, 40)));
			void next.promise.then(() => response.write(chunk(`\n\n${paragraphs(41, 60)}`)));
			void finish.promise.then(() => response.end(chunk(`\n\n${paragraphs(61, 80)}`, "stop") + "data: [DONE]\n\n"));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBeGreaterThan(0);
		const composer = loomPage.getByRole("textbox");
		await composer.fill("Write a long answer");
		await composer.press("Enter");

		const scroller = loomPage.locator(".agui-chat-viewport");
		const reply = loomPage.getByTestId("chat-assistant-message");
		const latest = loomPage.getByRole("button", { name: "Latest", exact: true });
		const distanceFromBottom = () => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
		await expect(reply.getByText("Paragraph 40.", { exact: true })).toBeVisible();
		await expect.poll(distanceFromBottom).toBeLessThan(2);

		await scroller.hover();
		await loomPage.mouse.wheel(0, -400);
		await expect.poll(distanceFromBottom).toBeGreaterThan(100);
		await expect(latest).toBeVisible();
		const readingPosition = await scroller.evaluate((element) => element.scrollTop);

		next.resolve();
		await expect(reply.getByText("Paragraph 60.", { exact: true })).toBeVisible();
		await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(readingPosition);
		await latest.click();
		await expect.poll(distanceFromBottom).toBeLessThan(2);
		await expect(latest).toBeHidden();

		finish.resolve();
		await expect(reply.getByText("Paragraph 80.", { exact: true })).toBeVisible();
		await expect.poll(distanceFromBottom).toBeLessThan(2);
	} finally {
		next.resolve();
		finish.resolve();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

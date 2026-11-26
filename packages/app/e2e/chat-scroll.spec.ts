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

test("switching back to a long chat keeps the first scroll steady while code highlighting loads", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	// Hold Streamdown's highlighted HTML until after the first wheel event.
	const highlighting = await loomPage.evaluateHandle(() => {
		const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
		const pending = new Map<Element, string>();
		Object.defineProperty(Element.prototype, "innerHTML", {
			...descriptor,
			set(this: Element, html: string) {
				if (this.hasAttribute("data-code-block") && html.startsWith("<pre")) pending.set(this, html);
				else descriptor.set!.call(this, html);
			},
		});
		return {
			ready: () => [...pending.keys()].some((element) => element.isConnected),
			release() {
				Object.defineProperty(Element.prototype, "innerHTML", descriptor);
				for (const [element, html] of pending) if (element.isConnected) descriptor.set!.call(element, html);
				pending.clear();
			},
		};
	});

	const lines = Array.from({ length: 95 }, (_, index) => `print(${index})`);
	lines[40] = "";
	lines[60] = `print("${"x".repeat(160)}")`;
	const paragraphs = Array.from({ length: 30 }, (_, index) => `History paragraph ${index + 1}.`).join("\n\n");
	const reply = `\`\`\`python\n${lines.join("\n")}\n\`\`\`\n\n${paragraphs}`;
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "code-scroll", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			response.end(chunk({ content: reply }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		const composer = loomPage.getByRole("textbox");
		await composer.fill("Show a long code example");
		await composer.press("Enter");
		const lastParagraph = loomPage.getByText("History paragraph 30.", { exact: true });
		await expect(lastParagraph).toBeVisible();
		await expect(loomPage.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
		const previous = loomPage.locator('.session-tab.active [role="tab"]');
		const sessionLabel = await previous.innerText();
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect(lastParagraph).toHaveCount(0);
		await loomPage.getByRole("tab", { name: sessionLabel, exact: true }).click();
		await expect(lastParagraph).toBeVisible();

		const viewport = loomPage.locator(".agui-chat-viewport");
		const highlighted = viewport.locator("[data-code-block]:visible .line").first();
		const metrics = () => viewport.evaluate((element) => ({ height: element.scrollHeight, top: element.scrollTop, view: element.clientHeight }));
		await expect.poll(() => highlighting.evaluate((gate) => gate.ready())).toBe(true);
		await expect(highlighted).toHaveCount(0);
		const distanceFromBottom = async () => {
			const { height, view, top } = await metrics();
			return height - view - top;
		};
		await expect.poll(distanceFromBottom).toBeLessThan(2);
		await viewport.hover();
		await loomPage.mouse.wheel(0, -120);
		await expect.poll(async () => Math.abs(await distanceFromBottom() - 120)).toBeLessThan(2);
		await expect(loomPage.getByRole("button", { name: "Latest", exact: true })).toBeVisible();
		const initial = await metrics();

		await highlighting.evaluate((gate) => gate.release());
		await expect(highlighted).toBeVisible();
		const settled = await metrics();
		expect(Math.abs(settled.height - initial.height)).toBeLessThanOrEqual(1);
		expect(Math.abs(settled.top - initial.top)).toBeLessThanOrEqual(1);
	} finally {
		await highlighting.evaluate((gate) => gate.release()).catch(() => undefined);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

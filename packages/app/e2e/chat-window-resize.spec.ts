import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, saveChatEndpoint, test } from "./loom.ts";

test("Windows caption buttons resize, minimize and close the window", async ({ loomPage: page, electronApp }) => {
	test.skip(process.platform !== "win32" || !electronApp || process.env.LOOM_E2E_VISIBLE !== "1", "visible Windows Electron required");
	const window = await electronApp!.browserWindow(page);
	const controls = page.locator(".window-caption-controls");
	const maximize = controls.getByRole("button", { name: "Maximize window" });
	const restore = controls.getByRole("button", { name: "Restore window" });
	const minimize = controls.getByRole("button", { name: "Minimize window" });
	const close = controls.getByRole("button", { name: "Close window" });
	await expect(controls).toHaveCSS("gap", "8px");
	await expect(maximize).toHaveCSS("width", "28px");
	await expect(controls).toHaveCSS("-webkit-app-region", "no-drag");

	await maximize.click();
	await expect.poll(() => window.evaluate((win) => win.isMaximized())).toBe(true);
	await restore.press("Enter");
	await expect.poll(() => window.evaluate((win) => win.isMaximized())).toBe(false);
	await window.evaluate((win) => win.maximize());
	await expect(restore).toBeVisible();
	await window.evaluate((win) => win.unmaximize());
	await expect(maximize).toBeVisible();

	await minimize.click();
	await expect.poll(() => window.evaluate((win) => win.isMinimized())).toBe(true);
	await window.evaluate((win) => win.restore());
	await expect.poll(() => window.evaluate((win) => win.isMinimized())).toBe(false);
	await Promise.all([
		page.waitForEvent("close"),
		close.click().catch((error) => {
			if (!page.isClosed()) throw error;
		}),
	]);
});

for (const nativeMaximize of [false, true]) test(`chat stays aligned after ${nativeMaximize ? "maximizing and restoring" : "growing and shrinking"} the window`, async ({ loomPage: page, electronApp }, testInfo) => {
	test.skip(!electronApp, "isolated window required");
	// Electron's maximize() shows a hidden window. Run that path only when visible tests were requested.
	test.skip(nativeMaximize && process.env.LOOM_E2E_VISIBLE !== "1", "native maximization shows the test window; requires LOOM_E2E_VISIBLE=1");
	const text = Array.from({ length: 60 }, (_, index) => `第${index + 1}行：汉皇重色思倾国，御宇多年求不得。`).join("\n");
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: "resize", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			response.end(chunk({ reasoning_content: "Considering the long reply. ".repeat(100) }) + chunk({ content: text }) + chunk({}, "stop") + "data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(page, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await expect(page.getByRole("textbox")).toBeVisible();
		await page.getByRole("textbox").fill("Recite a long poem");
		await page.getByRole("textbox").press("Enter");
		await expect(page.getByTestId("copilot-assistant-message")).toContainText("第60行");
		const window = await electronApp!.browserWindow(page);
		const geometry = () => page.evaluate(() => {
			const chat = document.querySelector<HTMLElement>(".agent-chat")!;
			const scroll = document.querySelector<HTMLElement>(".session-chat-scroll")!;
			const messages = document.querySelector<HTMLElement>('[data-testid="copilot-message-list"]')!;
			const composer = document.querySelector<HTMLElement>('[data-testid="copilot-chat-input"]')!;
			const bounds = (element: HTMLElement) => { const { x, width } = element.getBoundingClientRect(); return { x, width }; };
			return { viewport: innerWidth, chat: bounds(chat), scroll: bounds(scroll), messages: bounds(messages), composer: bounds(composer), scrollLeft: scroll.scrollLeft, clientWidth: scroll.clientWidth };
		});
		await window.evaluate(win => win.setSize(1200, 800));
		await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1200);
		const before = await geometry();
		const originallyVisible = await window.evaluate(win => win.isVisible());
		for (let cycle = 0; cycle < 2; cycle++) {
			if (nativeMaximize) {
				await window.evaluate(win => win.maximize());
				await expect.poll(() => window.evaluate(win => win.isMaximized())).toBe(true);
			} else await window.evaluate(win => win.setSize(1800, 1000));
			await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThan(before.viewport);
			if (nativeMaximize) {
				await window.evaluate(win => win.unmaximize());
				await expect.poll(() => window.evaluate(win => win.isMaximized())).toBe(false);
			} else await window.evaluate(win => win.setSize(1200, 800));
			await expect.poll(geometry).toEqual(before);
			if (!nativeMaximize) expect(await window.evaluate(win => win.isVisible())).toBe(originallyVisible);
		}
		if (nativeMaximize) await page.screenshot({ path: testInfo.outputPath("restored.png") });
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

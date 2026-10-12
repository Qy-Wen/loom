import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { launchTestElectron } from "./loom.ts";

test("trace window updates live and reads persisted runs after Electron restarts", async () => {
	test.skip(process.env.LOOM_E2E_TRACE !== "1", "build with LOOM_E2E_TRACE=1 for isolated trace-window acceptance");
	test.setTimeout(60_000);
	const root = await mkdtemp(join(tmpdir(), "loom-trace-e2e-"));
	const library = join(root, "library"); const userData = join(root, "user-data");
	let app: ElectronApplication | undefined;
	let held: ServerResponse | undefined;
	let requests = 0;
	const server = createServer((_request, response) => {
		requests++; held = response;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(`data: ${JSON.stringify({ id: "trace", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content: `VISIBLE_TRACE_${requests}` }, finish_reason: null }] })}\n\n`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const close = async () => { await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {}); app = undefined; };
	const openTrace = async (page: Page) => {
		const opened = app!.waitForEvent("window");
		await page.evaluate(() => window.loom.openDevTrace!());
		const trace = await opened; await trace.waitForLoadState();
		await expect(trace.locator(".trace-app")).toBeVisible(); return trace;
	};
	try {
		await mkdir(library); await mkdir(userData);
		await writeFile(join(userData, "last-library.json"), JSON.stringify({ rootPath: library }));
		await writeFile(join(userData, "general.json"), JSON.stringify({ language: "en", reopenLastLibrary: true }));
		app = await launchTestElectron(userData); let page = await app.firstWindow();
		await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
		await page.evaluate(async (baseUrl) => {
			const current = await window.loom.getModelSettings();
			await window.loom.saveModelSettings({ ...current, chat: { baseUrl, model: "demo", apiKey: "trace-private-key", enabled: true } });
		}, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		let trace = await openTrace(page);
		for (let turn = 1; turn <= 2; turn++) {
			await page.getByRole("textbox").fill(`trace question ${turn}`); await page.getByRole("textbox").press("Enter");
			await expect(page.getByText(`VISIBLE_TRACE_${turn}`, { exact: true })).toBeVisible();
			await expect.poll(async () => (await trace.evaluate(() => window.loomDev.getTraces())).some((record) => record.status === "running" && record.spans.some((span) => String(span.attributes["loom.io.output"]).includes(`VISIBLE_TRACE_${turn}`)))).toBe(true);
			await expect(trace.locator(".trace-item-summary").filter({ hasText: "running" })).toHaveCount(1);
			await trace.locator(".trace-row").filter({ hasText: "demo" }).last().click();
			await expect(trace.locator(".trace-io")).toContainText(`VISIBLE_TRACE_${turn}`);
			held!.end('data: {"id":"trace","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105}}\n\ndata: [DONE]\n\n'); held = undefined;
			await expect(trace.locator(".trace-item-summary").filter({ hasText: "completed" })).toHaveCount(turn);
		}
		const records = await trace.evaluate(() => window.loomDev.getTraces());
		expect(records).toHaveLength(2); expect(JSON.stringify(records)).not.toContain("trace-private-key");
		await close();
		app = await launchTestElectron(userData); page = await app.firstWindow();
		await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
		trace = await openTrace(page);
		await expect(trace.locator(".trace-item-summary").filter({ hasText: "completed" })).toHaveCount(2);
		expect(await trace.evaluate(() => window.loomDev.getTraces())).toEqual(records);
		expect(requests).toBe(2);
	} finally {
		held?.end(); await close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
	}
});

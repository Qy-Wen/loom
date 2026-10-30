import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ElectronApplication, Page } from "playwright";
import { test, expect, launchTestElectron, saveChatEndpoint } from "./loom.ts";
import { splitTraceBlobs, traceBlobMark } from "@loom/agent/trace-blob";
import type { DevTraceRecord } from "../src/shared/dev-trace.ts";

test("trace and metrics windows update live, link exemplars, persist, and reset on library switch", async () => {
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
		await saveChatEndpoint(page, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		const picker = page.getByRole("button", { name: "Conversation model", exact: true });
		await picker.click();
		await page.getByRole("menuitemradio", { name: "demo (e2e-chat)", exact: true }).click();
		await expect(picker).toHaveText("demo (e2e-chat)");
		let trace = await openTrace(page);
		for (let turn = 1; turn <= 2; turn++) {
			await page.getByRole("textbox").fill(`trace question ${turn}`); await page.getByRole("textbox").press("Enter");
			await expect(page.getByText(`VISIBLE_TRACE_${turn}`, { exact: true })).toBeVisible();
			await expect.poll(async () => (await trace.evaluate(() => window.loomDev.getTraces())).some((record) => record.status === "running" && record.spans.some((span) => String(span.attributes["loom.io.output"]).includes(`VISIBLE_TRACE_${turn}`)))).toBe(true);
			await expect(trace.locator(".trace-item-summary").filter({ hasText: "running" })).toHaveCount(1);
			await trace.locator(".trace-item").first().click();
			await trace.locator(".trace-row").filter({ hasText: "demo" }).last().click();
			await expect(trace.locator(".trace-io")).toContainText(`VISIBLE_TRACE_${turn}`);
			if (turn === 1) {
				await trace.getByRole("tab", { name: "原始内容", exact: true }).click();
				const record = (await trace.evaluate(() => window.loomDev.getTraces())).find((row) => row.status === "running")!;
				const request = record.spans.find((span) => span.name === "pi.ai.request")!;
				const parts = splitTraceBlobs(String(request.attributes["loom.io.input"]));
				const reference = parts.find((part) => "hash" in part)!;
				expect("hash" in reference && reference.previewJson !== undefined).toBe(true);
				expect(() => JSON.parse(String(request.attributes["loom.io.input"]))).not.toThrow();
				const sent = trace.locator(".trace-io section").filter({ has: trace.getByRole("heading", { name: "Sent", exact: true }) });
				await expect(sent.locator(".trace-json")).toBeVisible();
				await expect(sent.locator('.trace-json-toggle[aria-expanded="false"]')).toHaveCount(0);
				const preamble = sent.locator('[data-json-path="/0/sections/preamble"] .trace-json-value');
				expect(await preamble.textContent()).toBe(JSON.stringify(record.blobs![reference.hash]));
				await sent.getByRole("button", { name: "Collapse /0/sections/preamble", exact: true }).click();
				await expect(sent.getByRole("button", { name: "Expand /0/sections/preamble", exact: true })).toHaveAttribute("aria-expanded", "false");
				expect(await preamble.textContent()).toBe(reference.previewJson);
				await sent.getByRole("button", { name: "Collapse /0/sections", exact: true }).click();
				await expect(preamble).toHaveCount(0);
				await sent.getByRole("button", { name: "Expand /0/sections", exact: true }).click();
				await expect(sent.getByRole("button", { name: "Expand /0/sections/preamble", exact: true })).toHaveAttribute("aria-expanded", "false");
				await sent.getByRole("button", { name: "Expand /0/sections/preamble", exact: true }).click();
				expect(await preamble.textContent()).toBe(JSON.stringify(record.blobs![reference.hash]));
				await trace.getByRole("tab", { name: "Metrics", exact: true }).click();
				const row = trace.getByRole("row").filter({ hasText: "pi.ai.first_chunk.duration" }).first();
				await expect(row).toBeVisible();
				await row.locator("summary").click();
				await expect(row).toContainText("Time to the first normalized stream event.");
				await row.getByRole("button", { name: /^Trace ·/ }).first().click();
				await expect(trace.getByRole("tab", { name: "Traces", exact: true })).toHaveAttribute("aria-selected", "true");
				await expect(trace.locator(".trace-io")).toContainText("VISIBLE_TRACE_1");
			}
			held!.end('data: {"id":"trace","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105}}\n\ndata: [DONE]\n\n'); held = undefined;
			await expect(trace.locator(".trace-turn-header").filter({ hasText: "completed" })).toHaveCount(turn);
			await expect(trace.locator(".trace-item")).toHaveCount(1);
		}
		const records = await trace.evaluate(() => window.loomDev.getTraces());
		const conversations = await trace.evaluate(() => window.loomDev.getConversations());
		expect(conversations).toHaveLength(1); expect(conversations[0]!.count).toBe(2);
		expect(await trace.evaluate((id) => window.loomDev.getConversation(id), conversations[0]!.id)).toHaveLength(2);
		expect(records).toHaveLength(2); expect(JSON.stringify(records)).not.toContain("trace-private-key");
		await trace.getByRole("tab", { name: "Metrics", exact: true }).click();
		await expect(trace.getByRole("row").filter({ hasText: "pi.ai.tokens" }).first()).toBeVisible();
		const metrics = (await trace.evaluate(() => window.loomDev.getMetrics())).filter((row) => row.name.startsWith("pi.ai."));
		expect(metrics.filter((row) => row.name === "pi.ai.tokens" && row.attributes.kind === "input").reduce((sum, row) => sum + row.sum, 0)).toBe(200);
		expect(metrics.filter((row) => row.name === "pi.ai.tokens" && row.attributes.kind === "output").reduce((sum, row) => sum + row.sum, 0)).toBe(10);
		expect(metrics.find((row) => row.name === "pi.ai.request.duration")?.exemplars?.length).toBeGreaterThan(0);
		const phaseMetric = (await trace.evaluate(() => window.loomDev.getMetrics())).find((row) => row.name === "pi.durable.phase.duration" && row.attributes.task === "pi.generation")!;
		const phase = trace.getByRole("row").filter({ hasText: "pi.durable.phase.duration" }).filter({ hasText: '"task":"pi.generation"' }).first();
		await phase.locator("summary").click();
		await phase.getByRole("button", { name: /^Trace ·/ }).last().click();
		await trace.getByRole("tab", { name: "概述", exact: true }).click();
		await expect(trace.locator(".trace-facts")).toContainText(phaseMetric.exemplars!.at(-1)!.spanId);
		await close();
		app = await launchTestElectron(userData); page = await app.firstWindow();
		await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
		trace = await openTrace(page);
		await expect(trace.locator(".trace-item-summary").filter({ hasText: "completed" })).toHaveCount(1);
		await expect(trace.locator(".trace-turn-header").filter({ hasText: "completed" })).toHaveCount(2);
		expect(await trace.evaluate(() => window.loomDev.getTraces())).toEqual(records);
		await trace.getByRole("tab", { name: "Metrics", exact: true }).click();
		await expect(trace.getByRole("row").filter({ hasText: "pi.ai.tokens" }).first()).toBeVisible();
		expect((await trace.evaluate(() => window.loomDev.getMetrics())).filter((row) => row.name.startsWith("pi.ai."))).toEqual(metrics);
		expect(requests).toBe(2);
		const otherLibrary = join(root, "other-library"); await mkdir(otherLibrary);
		await app.evaluate(({ dialog }, path) => {
			const original = dialog.showOpenDialog;
			dialog.showOpenDialog = (async () => {
				dialog.showOpenDialog = original;
				return { canceled: false, filePaths: [path] };
			}) as typeof dialog.showOpenDialog;
		}, otherLibrary);
		await page.evaluate(() => window.loom.openLibrary());
		await expect(trace.getByText("No metrics yet.", { exact: true })).toBeVisible();
		expect(await trace.evaluate(() => window.loomDev.getMetrics())).toEqual([]);
		await trace.getByRole("tab", { name: "Traces", exact: true }).click();
		await expect(trace.locator(".trace-item")).toHaveCount(0);
	} finally {
		held?.end(); await close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
	}
});

test("event overview shows native start/end times, live settlement, snapshot sources and recovery caveats", async ({ loomPage, electronApp }) => {
	test.skip(process.env.LOOM_E2E_TRACE !== "1" || !electronApp, "isolated trace-enabled build required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const opened = electronApp!.waitForEvent("window"); await loomPage.evaluate(() => window.loom.openDevTrace!());
	const trace = await opened; await trace.waitForLoadState(); await expect(trace.locator(".trace-app")).toBeVisible();
	const at = new Date(2026, 9, 30, 8, 9, 7, 5).getTime();
	const record: DevTraceRecord = { id: "timestamp-test", threadId: "1", at, revision: 1, status: "running", spans: [
		{ id: "timestamp-request", traceId: "timestamp-test", name: "pi.ai.request", startedMs: at + 0.25, attributes: { model: "timestamp-model", "loom.io.input": JSON.stringify([{ role: "system", content: "PROMPT" }, { role: "user", content: "USER" }]), "loom.io.output": '"reply"' }, events: [], links: [], status: { status: "ok" } },
	] };
	const publish = (record: DevTraceRecord) => electronApp!.evaluate(({ BrowserWindow }, record) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.webContents.send("loom:devTrace", record), record);
	const facts = trace.locator(".trace-facts");
	const value = (label: string) => facts.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }).locator("+ dd");
	await publish(record);
	await trace.locator('.trace-event[data-kind="assistant"]').click();
	await trace.getByRole("tab", { name: "概述", exact: true }).click();
	await expect(value("开始时间")).toHaveText("2026-10-30 08:09:07.005");
	await expect(value("开始时间").locator("time")).toHaveAttribute("datetime", new Date(at).toISOString());
	await expect(value("结束时间")).toHaveText("运行中（尚未结束）");
	const settled = { ...record, revision: 2, status: "completed" as const, spans: [{ ...record.spans[0]!, endedMs: at + 1000.75 }] };
	await publish(settled);
	await expect(value("结束时间")).toHaveText("2026-10-30 08:09:08.005");
	await expect(value("耗时")).toHaveText("1.0s");
	// Switching to the snapshot does not replace the source request's timestamps with its visual position.
	await trace.locator('.trace-event[data-kind="system"]').click();
	await trace.getByRole("tab", { name: "概述", exact: true }).click();
	await expect(value("来源调用开始时间")).toHaveText("2026-10-30 08:09:07.005");
	await expect(value("来源调用结束时间")).toHaveText("2026-10-30 08:09:08.005");
	await expect(trace.locator(".trace-io")).toContainText("请求快照没有独立起止时间");
	await publish({ ...settled, revision: 3, status: "interrupted", spans: [{ ...settled.spans[0]!, interrupted: true }] });
	await trace.locator('.trace-event[data-kind="assistant"]').click();
	await trace.getByRole("tab", { name: "概述", exact: true }).click();
	await expect(value("结束时间")).toHaveText("2026-10-30 08:09:08.005（恢复时补填）");
	await expect(value("耗时")).toHaveText("无法确定（执行中断）");
	await expect(trace.locator(".trace-io")).toContainText("不代表真实结束时刻");
	await publish({ ...record, revision: 4, status: "interrupted", spans: [{ ...record.spans[0]!, interrupted: true }] });
	await expect(value("结束时间")).toHaveText("未采集（执行中断）");
});

test("detail tabs persist across events, conversations, closing details and live updates without sharing content folds", async ({ loomPage, electronApp }) => {
	test.skip(process.env.LOOM_E2E_TRACE !== "1" || !electronApp, "isolated trace-enabled build required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const opened = electronApp!.waitForEvent("window"); await loomPage.evaluate(() => window.loom.openDevTrace!());
	const trace = await opened; await trace.waitForLoadState(); await expect(trace.locator(".trace-app")).toBeVisible();
	const at = Date.now();
	const record = (id: string, threadId: string, offset: number): DevTraceRecord => ({ id, threadId, at: at + offset, revision: 1, status: "completed", spans: [
		{ id: `${id}-request`, traceId: id, name: "pi.ai.request", startedMs: at + offset, endedMs: at + offset + 10, attributes: { model: "tab-model", "loom.io.input": JSON.stringify({ nested: { value: `INPUT_${id}` } }), "loom.io.output": JSON.stringify([{ type: "text", text: `REPLY_${id}` }]) }, events: [], links: [], status: { status: "ok" } },
	] });
	const a = record("tab-a", "1", 0), b = record("tab-b", "1", 100), c = record("tab-c", "2", 200);
	const publish = (record: DevTraceRecord | null) => electronApp!.evaluate(({ BrowserWindow }, record) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.webContents.send("loom:devTrace", record), record);
	const row = (id: string) => trace.locator('.trace-event[data-kind="assistant"]').filter({ hasText: `REPLY_${id}` });
	const tab = (name: string) => trace.getByRole("tab", { name, exact: true });
	const sent = trace.locator(".trace-io section").filter({ has: trace.getByRole("heading", { name: "Sent", exact: true }) });
	await publish(a); await publish(b); await row("tab-a").click();
	await expect(tab("预览")).toHaveAttribute("aria-selected", "true");
	await tab("原始内容").click();
	await sent.getByRole("button", { name: "Collapse /nested", exact: true }).click();
	await trace.locator(".trace-native summary").click();
	await row("tab-b").click();
	await expect(tab("原始内容")).toHaveAttribute("aria-selected", "true");
	await expect(sent).toContainText("INPUT_tab-b");
	await expect(sent.getByRole("button", { name: "Collapse /nested", exact: true })).toHaveAttribute("aria-expanded", "true");
	await expect(trace.locator(".trace-native")).not.toHaveAttribute("open", "");
	await trace.getByRole("button", { name: "关闭详情", exact: true }).click(); await row("tab-a").click();
	await expect(tab("原始内容")).toHaveAttribute("aria-selected", "true");
	await publish({ ...a, revision: 2 });
	await expect(tab("原始内容")).toHaveAttribute("aria-selected", "true");
	await tab("Metrics").click(); await tab("Traces").click();
	await expect(tab("原始内容")).toHaveAttribute("aria-selected", "true");
	await publish(c); await trace.locator(".trace-item").filter({ hasText: "会话 2" }).click(); await row("tab-c").click();
	await expect(tab("原始内容")).toHaveAttribute("aria-selected", "true");
	await expect(sent).toContainText("INPUT_tab-c"); await expect(sent).not.toContainText("INPUT_tab-a");
	await tab("概述").click();
	await trace.locator(".trace-item").filter({ hasText: "会话 1" }).click(); await row("tab-b").click();
	await expect(tab("概述")).toHaveAttribute("aria-selected", "true");
	await expect(trace.locator(".trace-facts")).toContainText("tab-b-request");
	await row("tab-a").click(); await expect(tab("概述")).toHaveAttribute("aria-selected", "true");
	await tab("预览").click(); await row("tab-b").click();
	await expect(tab("预览")).toHaveAttribute("aria-selected", "true");
	await expect(trace.locator(".trace-io")).toContainText("REPLY_tab-b");
});

test("JSON fields default to expanded, preserve manual folds on live updates, and support legacy text", async ({ loomPage, electronApp }) => {
	test.skip(process.env.LOOM_E2E_TRACE !== "1" || !electronApp, "isolated trace-enabled build required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const opened = electronApp!.waitForEvent("window");
	await loomPage.evaluate(() => window.loom.openDevTrace!());
	const trace = await opened; await trace.waitForLoadState();
	await expect(trace.locator(".trace-app")).toBeVisible();
	const hash = "0123456789abcdef";
	const full = 'Use "derived from".\nC:\\assets\\still.png\n' + "instruction ".repeat(100) + "FULL_TEXT_END";
	const input = { nested: { first: { preamble: `preview… ${traceBlobMark(hash, full.length)}` }, second: [{ ok: true, count: 0 }, null] }, "a/b~c": { child: "strange key" }, missing: `missing preview… ${traceBlobMark("fedcba9876543210", 1000)}` };
	const at = Date.now();
	const record: DevTraceRecord = {
		id: "json-test", threadId: "1", at, revision: 1, status: "completed", blobs: { [hash]: full }, spans: [
			{ id: "json-span", traceId: "json-test", name: "pi.ai.request", startedMs: at, endedMs: at + 1, attributes: { model: "json-model", "loom.io.input": JSON.stringify(input), "loom.io.output": JSON.stringify([{ type: "text", text: "reply" }]) }, events: [{ name: "first", timeMs: 0, attributes: { value: false } }], links: [], status: { status: "ok" } },
			{ id: "legacy-span", traceId: "json-test", name: "pi.ai.request", startedMs: at, endedMs: at + 1, attributes: { model: "legacy-model", "loom.io.input": `{"preamble": ${JSON.stringify(`preview… ${traceBlobMark(hash, full.length)}`)}, "cut":` }, events: [], links: [], status: { status: "ok" } },
		],
	};
	const publish = (value: DevTraceRecord) => electronApp!.evaluate(({ BrowserWindow }, value) => {
		BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.webContents.send("loom:devTrace", value);
	}, value);
	await publish(record);
	await trace.locator(".trace-row").filter({ hasText: "json-model" }).click();
	await trace.getByRole("tab", { name: "原始内容", exact: true }).click();
	const sent = trace.locator(".trace-io section").filter({ has: trace.getByRole("heading", { name: "Sent", exact: true }) });
	await expect(trace.locator('.trace-io .trace-json-toggle[aria-expanded="false"]')).toHaveCount(0);
	await expect(sent).toContainText("FULL_TEXT_END");
	await expect(sent.locator('[data-json-path="/missing"] .trace-blob-missing')).toHaveText("[full text unavailable]");
	await expect(sent.getByRole("button", { name: "Collapse /a~1b~0c", exact: true })).toBeVisible();
	const value = sent.locator('[data-json-path="/nested/first/preamble"] .trace-json-value');
	expect(await value.textContent()).toBe(JSON.stringify(full));
	await sent.getByRole("button", { name: "Collapse /nested/first/preamble", exact: true }).click();
	expect(await value.textContent()).toBe('"preview…"');
	await publish({ ...record, revision: 2, spans: [{ ...record.spans[0]!, attributes: { ...record.spans[0]!.attributes, "loom.io.input": JSON.stringify({ ...input, fresh: { visible: "NEW_FIELD_VISIBLE" } }) } }, record.spans[1]!] });
	await expect(sent).toContainText("NEW_FIELD_VISIBLE");
	await expect(sent.getByRole("button", { name: "Expand /nested/first/preamble", exact: true })).toHaveAttribute("aria-expanded", "false");
	await sent.getByRole("button", { name: "Collapse /nested", exact: true }).click();
	await expect(value).toHaveCount(0);
	await sent.getByRole("button", { name: "Expand /nested", exact: true }).click();
	await expect(sent.getByRole("button", { name: "Expand /nested/first/preamble", exact: true })).toBeVisible();
	await trace.locator(".trace-row").filter({ hasText: "legacy-model" }).click();
	await trace.getByRole("tab", { name: "原始内容", exact: true }).click();
	await expect(sent.locator(".trace-json-fallback")).toHaveText("Text view · not complete JSON");
	await expect(sent.locator(".trace-blob-toggle")).toHaveAttribute("aria-expanded", "true");
	expect(await sent.locator(".trace-blob-value").textContent()).toBe(JSON.stringify(full));
	await sent.locator(".trace-blob-toggle").click();
	expect(await sent.locator(".trace-blob-value").textContent()).toBe('"preview…"');
	await trace.locator(".trace-row").filter({ hasText: "json-model" }).click();
	await trace.getByRole("tab", { name: "原始内容", exact: true }).click();
	await expect(sent.getByRole("button", { name: "Collapse /nested/first/preamble", exact: true })).toHaveAttribute("aria-expanded", "true");
});

test("trace dividers resize, clamp, reset, and retain preferences across tabs and window reopen", async ({ loomPage, electronApp }) => {
	test.skip(process.env.LOOM_E2E_TRACE !== "1" || !electronApp, "isolated trace-enabled build required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const open = async () => {
		const opened = electronApp!.waitForEvent("window");
		await loomPage.evaluate(() => window.loom.openDevTrace!());
		const page = await opened; await page.waitForLoadState();
		await expect(page.locator(".trace-app")).toBeVisible();
		return page;
	};
	let trace = await open();
	const at = Date.now();
	const record: DevTraceRecord = { id: "split-test", threadId: "1", at, revision: 1, status: "completed", spans: [
		{ id: "split-span", traceId: "split-test", name: "pi.ai.request", startedMs: at, endedMs: at + 1, attributes: { model: "split-model", "loom.io.input": '{"question":"test"}' }, events: [], links: [], status: { status: "ok" } },
	] };
	const publish = (value: DevTraceRecord) => electronApp!.evaluate(({ BrowserWindow }, value) => {
		BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.webContents.send("loom:devTrace", value);
	}, value);
	await publish(record);
	await trace.locator(".trace-row").filter({ hasText: "split-model" }).click();
	const divider = (axis: "x" | "y") => trace.getByRole("separator", { name: axis === "x" ? "调整会话列表宽度" : "调整事件详情宽度", exact: true });
	const size = async (axis: "x" | "y") => Number(await divider(axis).getAttribute("aria-valuenow"));
	const drag = async (axis: "x" | "y", delta: number) => {
		const box = (await divider(axis).boundingBox())!;
		const x = box.x + box.width / 2, y = box.y + box.height / 2;
		await trace.mouse.move(x, y); await trace.mouse.down();
		await trace.mouse.move(x + delta, y, { steps: 8 });
		await trace.mouse.up();
		await expect(trace.locator("body")).not.toHaveClass(/trace-resizing/);
	};
	await expect(divider("x")).toHaveAttribute("aria-valuenow", "220");
	const initialWidth = await size("y");
	await drag("x", 100); await expect(divider("x")).toHaveAttribute("aria-valuenow", "320");
	await expect.poll(() => size("y")).toBe(initialWidth - 50);
	const beforeDetailsDrag = await size("y");
	await drag("y", -30); expect(await size("y")).toBe(beforeDetailsDrag - 30);
	const preferredDetails = await size("y");
	await publish({ ...record, revision: 2 });
	await expect(divider("x")).toHaveAttribute("aria-valuenow", "320");
	expect(await size("y")).toBe(preferredDetails);
	await trace.getByRole("tab", { name: "Metrics", exact: true }).click();
	await trace.getByRole("tab", { name: "Traces", exact: true }).click();
	await expect(divider("x")).toHaveAttribute("aria-valuenow", "320");
	expect(await size("y")).toBe(preferredDetails);
	// ResizeObserver constrains actual sizes without overwriting the user's preferred width.
	await electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.setSize(720, 480));
	await expect.poll(() => size("x")).toBeLessThan(320);
	await electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.setSize(980, 720));
	await expect(divider("x")).toHaveAttribute("aria-valuenow", "320");
	await trace.close(); trace = await open(); await publish({ ...record, revision: 3 });
	await trace.locator(".trace-row").filter({ hasText: "split-model" }).click();
	await expect(divider("x")).toHaveAttribute("aria-valuenow", "320");
	expect(await size("y")).toBe(preferredDetails);
	await drag("x", -2000);
	expect(await size("x")).toBe(Number(await divider("x").getAttribute("aria-valuemin")));
	await drag("y", 2000);
	expect(await size("y")).toBe(Number(await divider("y").getAttribute("aria-valuemax")));
	await divider("x").press("End");
	expect(await size("x")).toBe(Number(await divider("x").getAttribute("aria-valuemax")));
	await divider("x").dblclick(); await expect(divider("x")).toHaveAttribute("aria-valuenow", "220");
	await divider("y").press("Home"); await expect(divider("y")).toHaveAttribute("aria-valuenow", "220");
	await divider("y").press("ArrowRight"); await expect(divider("y")).toHaveAttribute("aria-valuenow", "230");
	await divider("y").dblclick(); expect(await size("y")).toBe(initialWidth);
	// Losing window focus during a drag must not leave the resize cursor/selection lock behind.
	const box = (await divider("x").boundingBox())!;
	await trace.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await trace.mouse.down();
	await trace.evaluate(() => window.dispatchEvent(new Event("blur")));
	await expect(trace.locator("body")).not.toHaveClass(/trace-resizing/);
	await trace.mouse.up();
});

test("conversation ledger shows readable events, safe previews, independent folds, search and timeline focus", async ({ loomPage, electronApp }) => {
	test.skip(process.env.LOOM_E2E_TRACE !== "1" || !electronApp, "isolated trace-enabled build required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const opened = electronApp!.waitForEvent("window"); await loomPage.evaluate(() => window.loom.openDevTrace!());
	const trace = await opened; await trace.waitForLoadState(); await expect(trace.locator(".trace-app")).toBeVisible();
	const at = Date.now();
	const toolDefinitions = [{ name: "bash", description: "执行终端命令", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }, { name: "read", description: "读取文件", parameters: { type: "object", properties: { path: { type: "string" } } } }];
	const turn: DevTraceRecord = { id: "ledger-1", threadId: "1", at, revision: 1, status: "completed", spans: [
		{ id: "ledger-submit", traceId: "ledger-1", name: "pi.durable.submit", startedMs: at, endedMs: at + 1, attributes: { "submission.type": "input" }, events: [], links: [], status: { status: "ok" } },
		{ id: "ledger-phase", traceId: "ledger-1", parentId: "ledger-submit", name: "pi.durable.phase", startedMs: at + 1, endedMs: at + 501, attributes: { "task.name": "pi.generation", phase: "request", attempt: 1, outcome: "waiting" }, events: [], links: [], status: { status: "ok" } },
		{ id: "ledger-model", traceId: "ledger-1", parentId: "ledger-phase", name: "pi.ai.request", startedMs: at + 10, endedMs: at + 500, attributes: { model: "demo", "loom.io.input": JSON.stringify([{ role: "system", sections: { preamble: "SYSTEM_PROMPT\n… (42 bytes cut)", instructions: "当前素材库上下文" }, toolsAdded: [{ name: "removed-tool" }] }, { role: "user", content: "帮我看看目录" }, { role: "system", toolsRemoved: [{ name: "removed-tool" }], toolsAdded: toolDefinitions }]), "loom.io.output": JSON.stringify([{ type: "thinking", thinking: "先检查目录。" }, { type: "text", text: "**找到两个文件**\n\n- a.md\n- b.png\n\n![remote](https://example.invalid/private-image)\n\n<script>window.TRACE_UNSAFE=true</script>" }]) }, events: [{ name: "pi.ai.first_chunk", timeMs: 100, attributes: {} }], links: [], status: { status: "ok" } },
		{ id: "ledger-tool", traceId: "ledger-1", parentId: "ledger-submit", name: "pi.durable.phase", startedMs: at + 500, endedMs: at + 520, attributes: { "task.name": "pi.tool", "tool.name": "bash", phase: "call", "loom.io.input": '{"command":"ls"}', "loom.io.output": JSON.stringify([{ type: "text", text: 'a.md b.png\n---\n  157\n<script>unsafe</script>\n**not bold**' }]) }, events: [], links: [], status: { status: "ok" } },
	] };
	const publish = (record: DevTraceRecord) => electronApp!.evaluate(({ BrowserWindow }, record) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.webContents.send("loom:devTrace", record), record);
	await publish(turn);
	await publish({ ...turn, id: "ledger-2", at: at + 1000, spans: turn.spans.map((span) => ({ ...span, id: `second-${span.id}`, traceId: "ledger-2", startedMs: span.startedMs + 1000, endedMs: span.endedMs! + 1000 })) });
	await publish({ ...turn, id: "ledger-other", threadId: "2", at: at + 2000, spans: turn.spans.map((span) => ({ ...span, id: `other-${span.id}`, traceId: "ledger-other" })) });
	await expect(trace.locator(".trace-item")).toHaveCount(2);
	await trace.locator(".trace-item").last().click();
	await expect(trace.locator(".trace-turn-header")).toHaveCount(2);
	await expect(trace.locator('.trace-event[data-kind="system"]')).toHaveCount(1);
	await expect(trace.locator('.trace-event[data-kind="user"]')).toHaveCount(2);
	await expect(trace.locator('.trace-event[data-kind="phase"]')).toHaveCount(0);
	await expect(trace.getByRole("button", { name: "◷ 时长", exact: true })).toHaveAttribute("aria-pressed", "true");
	const modelBlock = trace.locator(".trace-overview-block.kind-assistant").first();
	const tooltip = trace.getByRole("tooltip");
	expect(await modelBlock.getAttribute("title")).toBeNull();
	await modelBlock.hover();
	await expect(tooltip).toBeVisible({ timeout: 500 });
	await expect(tooltip).toHaveText("助手 · 490ms · 首 chunk 100ms");
	await expect(modelBlock).toHaveAttribute("aria-describedby", (await tooltip.getAttribute("id"))!);
	await trace.mouse.move(0, 0); await expect(tooltip).toHaveCount(0);
	// A quick pass must not leave a delayed tooltip behind.
	await modelBlock.hover(); await trace.mouse.move(0, 0); await trace.waitForTimeout(200);
	await expect(tooltip).toHaveCount(0);
	const lastBlock = trace.locator(".trace-overview-block.kind-tool").last();
	await lastBlock.focus(); await expect(tooltip).toBeVisible({ timeout: 500 });
	await expect(tooltip).toHaveText("工具 · 20ms");
	const tipBounds = (await tooltip.boundingBox())!;
	expect(tipBounds.x).toBeGreaterThanOrEqual(0);
	expect(tipBounds.x + tipBounds.width).toBeLessThanOrEqual(await trace.evaluate(() => innerWidth));
	await lastBlock.press("Escape"); await expect(tooltip).toHaveCount(0);
	await lastBlock.hover(); await expect(tooltip).toBeVisible({ timeout: 500 });
	await trace.mouse.down(); await expect(tooltip).toHaveCount(0); await trace.mouse.up();
	await expect(trace.locator('.trace-event[data-kind="tool"]').first()).toContainText("→ a.md b.png");
	const system = trace.locator('.trace-event[data-kind="system"]');
	await expect(system.locator(".trace-event-summary")).toHaveText("系统提示词");
	await system.click();
	await expect(trace.locator(".trace-io")).toContainText("来自当前已加载历史中的首条模型请求记录");
	await expect(trace.locator(".trace-io")).toContainText("SYSTEM_PROMPT");
	const systemTools = trace.locator(".trace-system-tools");
	await expect(systemTools.locator("h3")).toContainText("工具列表（2）");
	const toolsToggle = systemTools.getByRole("button", { name: /^(收起|展开)工具列表$/ });
	await expect(toolsToggle).toHaveAttribute("aria-expanded", "true");
	await expect(systemTools).not.toContainText("可用工具：该次模型请求中提供的工具定义。");
	await expect(systemTools).not.toContainText("部分工具定义未完整保存。");
	await expect(systemTools).toContainText("执行终端命令");
	await expect(systemTools).toContainText("读取文件");
	await expect(systemTools).toContainText('"command"');
	await expect(systemTools).not.toContainText("removed-tool");
	await expect(systemTools).not.toContainText("帮我看看目录");
	const promptToggle = trace.locator(".trace-prompt-toggle");
	await expect(promptToggle).toHaveAttribute("aria-expanded", "true");
	await trace.getByRole("button", { name: "收起提示词正文", exact: true }).press("Enter");
	await expect(promptToggle).toHaveAttribute("aria-expanded", "false");
	await expect(trace.locator(".trace-prompt-content")).toBeHidden();
	await expect(trace.locator(".trace-prompt-content .trace-markdown")).toHaveCount(0);
	await expect(systemTools).toBeVisible();
	await expect(systemTools).toContainText("执行终端命令");
	await expect(systemTools.locator('.trace-json-node[data-json-path="/0/parameters"] > .trace-json-row button')).toHaveAttribute("aria-expanded", "true");
	await systemTools.locator('.trace-json-node[data-json-path="/0/parameters"] > .trace-json-row button').click();
	await systemTools.getByRole("button", { name: "收起工具列表", exact: true }).press("Enter");
	await expect(toolsToggle).toHaveAttribute("aria-expanded", "false");
	await expect(systemTools.locator(".trace-tools-content")).toBeHidden();
	await expect(promptToggle).toHaveAttribute("aria-expanded", "false");
	await publish({ ...turn, revision: 2 });
	await expect(systemTools.locator('.trace-json-node[data-json-path="/0/parameters"] > .trace-json-row button')).toHaveAttribute("aria-expanded", "false");
	await expect(promptToggle).toHaveAttribute("aria-expanded", "false");
	await expect(toolsToggle).toHaveAttribute("aria-expanded", "false");
	await trace.getByRole("button", { name: "展开提示词正文", exact: true }).press("Space");
	await expect(promptToggle).toHaveAttribute("aria-expanded", "true");
	await expect(trace.locator(".trace-prompt-content")).toContainText("SYSTEM_PROMPT");
	await expect(toolsToggle).toHaveAttribute("aria-expanded", "false");
	await systemTools.getByRole("button", { name: "展开工具列表", exact: true }).press("Space");
	await expect(toolsToggle).toHaveAttribute("aria-expanded", "true");
	await expect(systemTools.locator(".trace-tools-content")).toBeVisible();
	await expect(systemTools).toContainText("执行终端命令");
	await expect(systemTools.locator('.trace-json-node[data-json-path="/0/parameters"] > .trace-json-row button')).toHaveAttribute("aria-expanded", "false");
	await trace.getByRole("tab", { name: "原始内容", exact: true }).click();
	await expect(trace.locator(".trace-io")).toContainText("SYSTEM_PROMPT");
	await expect(systemTools).toContainText("执行终端命令");
	await expect(systemTools).toContainText('"command"');
	await expect(systemTools).not.toContainText("removed-tool");
	await expect(trace.locator(".trace-io")).not.toContainText("帮我看看目录");
	await expect(trace.locator(".trace-io")).not.toContainText("当前素材库上下文");
	await expect(trace.locator(".trace-io")).not.toContainText("找到两个文件");
	await expect(trace.getByRole("heading", { name: "Arguments", exact: true })).toHaveCount(0);
	await expect(trace.getByRole("heading", { name: "Result", exact: true })).toHaveCount(0);
	await expect(trace.getByRole("heading", { name: "来源调用的元数据与事件", exact: true })).toBeVisible();
	const model = turn.spans.find((span) => span.id === "ledger-model")!;
	const clippedMessages = JSON.parse(String(model.attributes["loom.io.input"]));
	clippedMessages.at(-1).toolsAdded[0].description = "执行终端命令\n… (42 bytes cut)";
	await publish({ ...turn, revision: 3, spans: turn.spans.map((span) => span === model ? { ...span, attributes: { ...span.attributes, "loom.io.input": JSON.stringify(clippedMessages) } } : span) });
	await expect(systemTools).toContainText("部分工具定义未完整保存。");
	await publish({ ...turn, revision: 4 });
	await expect(systemTools).not.toContainText("部分工具定义未完整保存。");
	await trace.locator('.trace-event[data-kind="context"]').first().click();
	await trace.getByRole("tab", { name: "原始内容", exact: true }).click();
	await expect(trace.locator(".trace-io")).toContainText("当前素材库上下文");
	await expect(trace.locator(".trace-io")).not.toContainText("SYSTEM_PROMPT");
	await expect(trace.locator(".trace-io")).not.toContainText("帮我看看目录");
	await trace.locator('.trace-event[data-kind="user"]').first().click();
	await trace.getByRole("tab", { name: "原始内容", exact: true }).click();
	await expect(trace.locator(".trace-io")).toContainText("帮我看看目录");
	await expect(trace.locator(".trace-io")).not.toContainText("SYSTEM_PROMPT");
	await expect(trace.locator(".trace-io")).not.toContainText("当前素材库上下文");
	await trace.locator('.trace-event[data-kind="assistant"]').first().click();
	await expect(trace.locator(".trace-io")).not.toContainText("来自当前已加载历史中的首条模型请求记录");
	await expect(trace.locator(".trace-request-number")).toHaveCount(0);
	await expect(trace.locator(".trace-details-header")).not.toContainText(/#\d+/);
	await expect(trace.getByRole("tab", { name: "原始内容", exact: true })).toHaveAttribute("aria-selected", "true");
	await trace.getByRole("tab", { name: "预览", exact: true }).click();
	await expect(trace.locator(".trace-io strong")).toHaveText("找到两个文件");
	await expect(trace.locator(".trace-io img")).toHaveCount(0); await expect(trace.locator(".trace-io script")).toHaveCount(0);
	await expect(trace.getByRole("button", { name: /^思考/ })).toHaveAttribute("aria-expanded", "true");
	await trace.getByRole("button", { name: /^思考/ }).click(); await expect(trace.locator(".trace-thinking")).not.toContainText("先检查目录。");
	await trace.getByRole("tab", { name: "概述", exact: true }).click(); await expect(trace.locator(".trace-io")).toContainText("首 chunk");
	await trace.getByRole("tab", { name: "原始内容", exact: true }).click();
	await expect(trace.getByRole("heading", { name: "元数据与事件", exact: true })).toBeVisible();
	const sent = trace.locator(".trace-io section").filter({ has: trace.getByRole("heading", { name: "Sent", exact: true }) });
	await expect(sent).toContainText("SYSTEM_PROMPT");
	await expect(sent).toContainText("帮我看看目录");
	await expect(trace.locator(".trace-native summary")).toHaveText("底层执行记录（4）");
	await trace.locator(".trace-native summary").click();
	await expect(trace.locator(".trace-native")).toContainText("waiting");
	await expect(trace.locator('.trace-event[data-kind="phase"]')).toHaveCount(0);
	await trace.getByRole("tab", { name: "预览", exact: true }).click();
	await trace.screenshot({ path: join(tmpdir(), "loom-trace-ledger.png") });
	const toolbar = trace.getByRole("toolbar", { name: "轨迹工具栏" });
	await toolbar.getByRole("button", { name: "⊟ 收起调用", exact: true }).click();
	await expect(trace.locator('.trace-event[data-kind="tool"]')).toHaveCount(0);
	await trace.locator('.trace-event[data-kind="assistant"]').first().click();
	await expect(trace.locator('.trace-event[data-kind="tool"]')).toHaveCount(0);
	await publish({ ...turn, revision: 5 }); await expect(trace.locator('.trace-event[data-kind="tool"]')).toHaveCount(0);
	await toolbar.getByRole("button", { name: "⊞ 展开调用", exact: true }).click(); await expect(trace.locator('.trace-event[data-kind="tool"]')).toHaveCount(2);
	await toolbar.getByRole("button", { name: "⊟ 收起轮次", exact: true }).click(); await expect(trace.locator(".trace-event")).toHaveCount(0);
	await trace.getByRole("searchbox", { name: "搜索轨迹" }).fill("bash"); await expect(trace.locator('.trace-event[data-kind="tool"]')).toHaveCount(2);
	await trace.getByRole("searchbox", { name: "搜索轨迹" }).fill("NO_MATCH_ANYWHERE"); await expect(trace.getByText("没有匹配事件", { exact: true })).toBeVisible();
	await trace.getByRole("searchbox", { name: "搜索轨迹" }).fill("");
	await toolbar.getByRole("button", { name: "⊞ 展开轮次", exact: true }).click();
	await trace.locator('.trace-overview-block.kind-tool').first().press("Enter"); await expect(trace.locator(".trace-event.is-selected")).toHaveAttribute("data-kind", "tool");
	await expect(trace.getByRole("heading", { name: "调用工具", exact: true })).toBeVisible();
	await expect(trace.locator(".trace-tool-name")).toHaveText("bash");
	await expect(trace.locator(".trace-tool-output")).toHaveText('a.md b.png\n---\n  157\n<script>unsafe</script>\n**not bold**');
	await expect(trace.locator(".trace-io h2, .trace-io script, .trace-io strong")).toHaveCount(0);
	const outputStyle = await trace.locator(".trace-tool-output").evaluate((element) => {
		const style = getComputedStyle(element);
		return { fontSize: style.fontSize, whiteSpace: style.whiteSpace, borderWidth: style.borderTopWidth, background: style.backgroundColor, padding: style.padding };
	});
	expect(outputStyle).toEqual({ fontSize: "12px", whiteSpace: "pre-wrap", borderWidth: "0px", background: "rgba(0, 0, 0, 0)", padding: "0px" });
	await publish({ ...turn, revision: 6, spans: turn.spans.map((span) => span.id === "ledger-tool" ? { ...span, attributes: { ...span.attributes, "loom.io.output": '{"files":["a.md","b.png"]}' } } : span) });
	await expect(trace.locator(".trace-tool-output")).toHaveCount(0);
	await expect(trace.locator(".trace-tool-name")).toHaveText("bash");
	const resultSection = trace.locator(".trace-io section").filter({ has: trace.getByRole("heading", { name: "结果", exact: true }) });
	await expect(resultSection.locator(".trace-json")).toContainText('"files"');
	let resultRevision = 6;
	const publishResultText = (text: string) => publish({ ...turn, revision: ++resultRevision, spans: turn.spans.map((span) => span.id === "ledger-tool" ? { ...span, attributes: { ...span.attributes, "loom.io.output": JSON.stringify({ content: [{ type: "text", text }] }) } } : span) });
	const largeResultValue = "汉".repeat(6000);
	const jsonResult = JSON.stringify({ nested: { list: [1, { value: true }] }, literal: "<script>not executable</script>", large: largeResultValue });
	await publishResultText(jsonResult);
	await expect(resultSection.locator(".trace-json")).toContainText('"nested"');
	await expect(resultSection.locator(".trace-json")).toContainText("not executable");
	await expect(resultSection.locator('.trace-json-node[data-json-path="/large"] .trace-json-value')).toHaveText(JSON.stringify(largeResultValue));
	await expect(resultSection.locator(".trace-tool-output, script")).toHaveCount(0);
	const resultFold = resultSection.locator('.trace-json-node[data-json-path="/nested"] > .trace-json-row button');
	await expect(resultFold).toHaveAttribute("aria-expanded", "true");
	await resultFold.click();
	const argsSection = trace.locator(".trace-io section").filter({ has: trace.getByRole("heading", { name: "参数", exact: true }) });
	const argsFold = argsSection.locator('.trace-json-node[data-json-path=""] > .trace-json-row button');
	await expect(argsFold).toHaveAttribute("aria-expanded", "true");
	await argsFold.click();
	await publishResultText(jsonResult);
	await expect(resultFold).toHaveAttribute("aria-expanded", "false");
	await expect(argsFold).toHaveAttribute("aria-expanded", "false");
	for (const value of [null, false, 0, "literal string"]) {
		await publishResultText(JSON.stringify(value));
		await expect(resultSection.locator(".trace-json-value")).toHaveText([JSON.stringify(value)]);
		await expect(resultSection.locator(".trace-tool-output")).toHaveCount(0);
	}
	for (const text of ['{"partial":', 'log prefix\n{"valid":true}']) {
		await publishResultText(text);
		await expect(resultSection.locator(".trace-tool-output")).toHaveText(text);
		await expect(resultSection.locator(".trace-json")).toHaveCount(0);
	}
	await toolbar.getByRole("button", { name: "◷ 时长", exact: true }).click(); await expect(toolbar.getByRole("button", { name: "◷ 时长", exact: true })).toHaveAttribute("aria-pressed", "false");
	await toolbar.getByRole("button", { name: "◷ 时长", exact: true }).click(); await expect(toolbar.getByRole("button", { name: "◷ 时长", exact: true })).toHaveAttribute("aria-pressed", "true");
	const box = (await trace.locator(".trace-overview-track").boundingBox())!;
	await trace.mouse.move(box.x + box.width * .1, box.y + 10); await trace.mouse.down(); await trace.mouse.move(box.x + box.width * .3, box.y + 10, { steps: 6 }); await trace.mouse.up();
	await expect(trace.getByRole("button", { name: "清除范围", exact: true })).toBeVisible(); await expect(trace.locator(".trace-overview-range")).toBeVisible();
	await trace.locator(".trace-overview-track").press("Escape"); await expect(trace.locator(".trace-overview-range")).toHaveCount(0);
	await trace.getByRole("button", { name: "关闭详情", exact: true }).click(); await expect(trace.locator(".trace-event-details")).toHaveCount(0);
	await trace.locator(".trace-item").first().click(); await expect(trace.locator(".trace-turn-header")).toHaveCount(1);
});

test("duration mode is the default and zero-duration calls stay visible and clickable at the right edge", async ({ loomPage, electronApp }) => {
	test.skip(process.env.LOOM_E2E_TRACE !== "1" || !electronApp, "isolated trace-enabled build required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const opened = electronApp!.waitForEvent("window"); await loomPage.evaluate(() => window.loom.openDevTrace!());
	const trace = await opened; await trace.waitForLoadState();
	const at = Date.now();
	const record: DevTraceRecord = { id: "minimum-span", threadId: "1", at, revision: 1, status: "completed", spans: [
		{ id: "minimum-model", traceId: "minimum-span", name: "pi.ai.request", startedMs: at, endedMs: at + 10_000, attributes: { model: "demo", "loom.io.output": '"reply"' }, events: [], links: [], status: { status: "ok" } },
		...[["long", 2000, 6000], ["short", 9000, 9000.1], ["zero", 10_000, 10_000]].map(([name, start, end]) => ({ id: `minimum-${name}`, traceId: "minimum-span", name: "pi.durable.phase", startedMs: at + Number(start), endedMs: at + Number(end), attributes: { "task.name": "pi.tool", "tool.name": String(name), phase: "call", "loom.io.output": '"done"' }, events: [], links: [], status: { status: "ok" as const } })),
	] };
	await electronApp!.evaluate(({ BrowserWindow }, record) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.webContents.send("loom:devTrace", record), record);
	await trace.locator(".trace-item").first().click();
	const mode = trace.getByRole("button", { name: "◷ 时长", exact: true });
	await expect(mode).toHaveAttribute("aria-pressed", "true");
	const track = trace.locator(".trace-overview-track");
	const long = track.getByRole("button", { name: /^工具 · long / });
	const short = track.getByRole("button", { name: /^工具 · short / });
	const zero = track.getByRole("button", { name: /^工具 · zero / });
	const checkWidths = async () => {
		const bounds = (await track.boundingBox())!;
		expect((await long.boundingBox())!.width).toBeCloseTo((bounds.width - 12) * .4 - 1, 0); // Input and terminal zero reserve slots; the short call is concurrent with the model.
		for (const block of [short, zero]) {
			const painted = (await block.boundingBox())!;
			expect(painted.width).toBeGreaterThanOrEqual(6);
			expect(painted.x + painted.width).toBeLessThanOrEqual(bounds.x + bounds.width + .1);
		}
	};
	await checkWidths();
	await zero.hover(); await expect(trace.getByRole("tooltip")).toHaveText("工具 · 0ms");
	// Click near the end of the inflated marker, not at its theoretical zero-width timestamp.
	await zero.click({ position: { x: 5, y: 4 } });
	await expect(trace.locator(".trace-tool-name")).toHaveText("zero");
	await trace.getByRole("tab", { name: "概述", exact: true }).click();
	await expect(trace.locator(".trace-facts dd")).toContainText(["0ms"]);
	await checkWidths(); // Minima still fit with details open.
	await mode.click(); await expect(mode).toHaveAttribute("aria-pressed", "false");
	const equalWidths = await track.locator(".trace-overview-block").evaluateAll((blocks) => blocks.map((block) => block.getBoundingClientRect().width));
	expect(Math.max(...equalWidths) - Math.min(...equalWidths)).toBeLessThan(1);
	await mode.click(); await expect(mode).toHaveAttribute("aria-pressed", "true");
	await checkWidths();
});

test("zero-duration boundary spans join the following call instead of sharing its start", async ({ loomPage, electronApp }) => {
	test.skip(process.env.LOOM_E2E_TRACE !== "1" || !electronApp, "isolated trace-enabled build required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const opened = electronApp!.waitForEvent("window"); await loomPage.evaluate(() => window.loom.openDevTrace!());
	const trace = await opened; await trace.waitForLoadState();
	const at = Date.now();
	const record: DevTraceRecord = { id: "zero-sequence", threadId: "1", at, revision: 1, status: "completed", spans: [
		{ id: "sequence-submit", traceId: "zero-sequence", name: "pi.durable.submit", startedMs: at, endedMs: at + 1, attributes: { "submission.type": "input" }, events: [], links: [], status: { status: "ok" } },
		{ id: "sequence-request", traceId: "zero-sequence", name: "pi.ai.request", startedMs: at + 20, endedMs: at + 1000, attributes: { model: "demo", "loom.io.input": JSON.stringify([{ role: "system", content: "SYSTEM" }, { role: "user", content: "USER" }]), "loom.io.output": '"reply"' }, events: [], links: [], status: { status: "ok" } },
		...[ ["zero-a", 1000, 1000], ["zero-b", 1000, 1000], ["next", 1000, 2000] ].map(([name, start, end]) => ({ id: `sequence-${name}`, traceId: "zero-sequence", name: "pi.durable.phase", startedMs: at + Number(start), endedMs: at + Number(end), attributes: { "task.name": "pi.tool", "tool.name": String(name), phase: "call", "loom.io.output": '"done"' }, events: [], links: [], status: { status: "ok" as const } })),
	] };
	const publish = (record: DevTraceRecord) => electronApp!.evaluate(({ BrowserWindow }, record) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.webContents.send("loom:devTrace", record), record);
	await publish(record); await trace.locator(".trace-item").first().click();
	const track = trace.locator(".trace-overview-track");
	const system = track.locator(".kind-system"), user = track.locator(".kind-user"), model = track.locator(".kind-assistant");
	const zeroA = track.getByRole("button", { name: /^工具 · zero-a / }), zeroB = track.getByRole("button", { name: /^工具 · zero-b / }), next = track.getByRole("button", { name: /^工具 · next / });
	const checkJoined = async () => {
		for (const [before, after] of [[system, user], [zeroA, zeroB], [zeroB, next]]) {
			const a = (await before!.boundingBox())!, b = (await after!.boundingBox())!;
			expect(a.width).toBeCloseTo(6, 0); expect(a.x + a.width).toBeCloseTo(b.x, 0);
		}
	};
	await checkJoined();
	expect((await user.boundingBox())!.x).toBeLessThan((await model.boundingBox())!.x);
	await system.click(); await trace.getByRole("tab", { name: "概述", exact: true }).click();
	await expect(trace.locator(".trace-facts")).toContainText("sequence-request"); // Snapshot retains its native source identity.
	await trace.getByRole("tab", { name: "预览", exact: true }).click();
	await zeroA.hover(); await expect(trace.getByRole("tooltip")).toHaveText("工具 · 0ms");
	await zeroA.click(); await expect(trace.locator(".trace-tool-name")).toHaveText("zero-a");
	await zeroB.click(); await expect(trace.locator(".trace-tool-name")).toHaveText("zero-b");
	await next.click(); await expect(trace.locator(".trace-tool-name")).toHaveText("next");
	const b = (await zeroB.boundingBox())!;
	await trace.mouse.move(b.x + 1, b.y + 4); await trace.mouse.down(); await trace.mouse.move(b.x + 5, b.y + 4, { steps: 4 }); await trace.mouse.up();
	await expect(trace.locator('.trace-event[data-kind="tool"]').filter({ hasText: "zero-a" })).toHaveAttribute("data-focus-outside", "true");
	await expect(trace.locator('.trace-event[data-kind="tool"]').filter({ hasText: "zero-b" })).not.toHaveAttribute("data-focus-outside", "true");
	await track.press("Escape");
	await publish({ ...record, revision: 2 }); await checkJoined();
	await trace.getByRole("separator", { name: "调整会话列表宽度", exact: true }).press("ArrowRight"); await checkJoined();
});

test("inter-turn idle time folds into a narrow marker while selection, range focus and native coverage stay accurate", async ({ loomPage, electronApp }) => {
	test.skip(process.env.LOOM_E2E_TRACE !== "1" || !electronApp, "isolated trace-enabled build required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const opened = electronApp!.waitForEvent("window"); await loomPage.evaluate(() => window.loom.openDevTrace!());
	const trace = await opened; await trace.waitForLoadState();
	const at = Date.now();
	const first: DevTraceRecord = { id: "gap-first", threadId: "1", at, revision: 1, status: "completed", spans: [
		{ id: "gap-first-model", traceId: "gap-first", name: "pi.ai.request", startedMs: at, endedMs: at + 1000, attributes: { model: "demo", "loom.io.output": '"FIRST"' }, events: [], links: [], status: { status: "ok" } },
		{ id: "gap-tool", traceId: "gap-first", name: "pi.durable.phase", startedMs: at + 1000, endedMs: at + 3000, attributes: { "task.name": "pi.tool", "tool.name": "bash", phase: "call" }, events: [], links: [], status: { status: "ok" } },
	] };
	const second: DevTraceRecord = { id: "gap-second", threadId: "1", at: at + 723_000, revision: 1, status: "completed", spans: [
		{ ...first.spans[0]!, id: "gap-second-model", traceId: "gap-second", startedMs: at + 723_000, endedMs: at + 724_000, attributes: { model: "demo", "loom.io.output": '"SECOND"' } },
	] };
	const publish = (record: DevTraceRecord) => electronApp!.evaluate(({ BrowserWindow }, record) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.webContents.send("loom:devTrace", record), record);
	await publish(first); await publish(second); await trace.locator(".trace-item").first().click();
	const track = trace.locator(".trace-overview-track"), gap = track.locator(".trace-overview-gap");
	const firstBlock = track.getByRole("button", { name: "助手 · FIRST", exact: true });
	const secondBlock = track.getByRole("button", { name: "助手 · SECOND", exact: true });
	await expect(gap).toHaveCount(1);
	const checkScale = async () => {
		const a = (await firstBlock.boundingBox())!, b = (await secondBlock.boundingBox())!;
		expect(a.width).toBeGreaterThan(50); expect(a.width).toBeCloseTo(b.width, 0);
		expect((await gap.boundingBox())!.width).toBeCloseTo(12, 0);
	};
	await checkScale();
	await gap.hover(); await expect(trace.getByRole("tooltip")).toHaveText("轮间间隔 12分钟（已折叠）");
	await gap.click(); await expect(trace.locator(".trace-event-details")).toHaveCount(0);
	await secondBlock.click(); await expect(trace.locator(".trace-io")).toContainText("SECOND");
	const b = (await secondBlock.boundingBox())!;
	await trace.mouse.move(b.x + b.width * .2, b.y + 4); await trace.mouse.down();
	await trace.mouse.move(b.x + b.width * .8, b.y + 4, { steps: 6 }); await trace.mouse.up();
	await expect(trace.locator('.trace-event[data-kind="assistant"]').filter({ hasText: "FIRST" })).toHaveAttribute("data-focus-outside", "true");
	await expect(trace.locator('.trace-event[data-kind="assistant"]').filter({ hasText: "SECOND" })).not.toHaveAttribute("data-focus-outside", "true");
	await track.press("Escape");
	const split = trace.getByRole("separator", { name: "调整会话列表宽度", exact: true });
	await split.press("ArrowRight"); await split.press("ArrowRight");
	await expect.poll(async () => (await gap.boundingBox())!.width).toBeCloseTo(12, 0); await checkScale();
	const mode = trace.getByRole("button", { name: "◷ 时长", exact: true });
	await mode.click(); await expect(gap).toHaveCount(0);
	await mode.click(); await expect(gap).toHaveCount(1); await checkScale();
	const bridge = { ...first.spans[1]!, id: "hidden-work", name: "pi.durable.phase", startedMs: at + 3000, endedMs: at + 724_000, attributes: { "task.name": "pi.generation", phase: "tools", outcome: "waiting" } };
	await publish({ ...first, revision: 2, spans: [...first.spans, bridge] });
	await expect(gap).toHaveCount(0); // Hidden native work covers the interval, so it must not be folded.
	await expect(trace.locator(".trace-io")).toContainText("SECOND");
	await publish({ ...first, revision: 3 }); await expect(gap).toHaveCount(1); await checkScale();
});

test("system details prefer complete independent tool snapshots and retain schema folds on updates", async ({ loomPage, electronApp }) => {
	test.skip(process.env.LOOM_E2E_TRACE !== "1" || !electronApp, "isolated trace-enabled build required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const opened = electronApp!.waitForEvent("window"); await loomPage.evaluate(() => window.loom.openDevTrace!());
	const trace = await opened; await trace.waitForLoadState();
	const at = Date.now(), hash = "0123456789abcdef";
	const description = "完整工具说明汉🙂 ".repeat(1000);
	const tools = Array.from({ length: 40 }, (_, i) => ({ name: `tool_${i}`, description: `${"preview ".repeat(80)}… ⟦blob:${hash}:${description.length}⟧`, parameters: { type: "object", properties: { headers: { type: "object", additionalProperties: { type: "string" } }, apiKey: { type: "string" } } } }));
	expect(Buffer.byteLength(JSON.stringify(tools))).toBeGreaterThan(32 * 1024);
	const source: DevTraceRecord = { id: "independent-tools", threadId: "1", at, revision: 1, status: "completed", blobs: { [hash]: description }, spans: [
		{ id: "tool-snapshot-request", traceId: "independent-tools", name: "pi.ai.request", startedMs: at, endedMs: at + 10, attributes: { model: "demo", "loom.io.input": JSON.stringify([{ role: "system", content: "PROMPT", toolsAdded: ["… (trace content omitted)"] }, { role: "user", content: "USER_ONLY" }]), "loom.io.tools": JSON.stringify(tools) }, events: [], links: [], status: { status: "ok" } },
	] };
	const publish = (record: DevTraceRecord) => electronApp!.evaluate(({ BrowserWindow }, record) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.webContents.send("loom:devTrace", record), record);
	await publish(source);
	await trace.locator(".trace-item").first().click();
	await trace.locator('.trace-event[data-kind="system"]').click();
	const list = trace.locator(".trace-system-tools");
	await expect(list.locator("h3")).toContainText("工具列表（40）");
	await expect(list).not.toContainText("部分工具定义未完整保存。");
	await expect(list).toContainText('"headers"'); await expect(list).toContainText('"apiKey"');
	await expect(list.locator('.trace-json-node[data-json-path="/0/description"] .trace-json-value')).toHaveText(JSON.stringify(description));
	await expect(list).not.toContainText("USER_ONLY");
	const fold = list.locator('.trace-json-node[data-json-path="/0/parameters"] > .trace-json-row button');
	await fold.click();
	await publish({ ...source, revision: 2 });
	await expect(fold).toHaveAttribute("aria-expanded", "false");
	await trace.getByRole("tab", { name: "原始内容", exact: true }).click();
	await expect(list).toContainText("工具列表（40）");
	await expect(list).not.toContainText("部分工具定义未完整保存。");
	await publish({ ...source, revision: 3, blobs: {} });
	await expect(list).toContainText("部分工具定义未完整保存。");
	await publish({ ...source, revision: 4 });
	await expect(list).not.toContainText("部分工具定义未完整保存。");
});

test("late conversation history cannot leak across a library reset with reused conversation IDs", async ({ loomPage, electronApp }) => {
	test.skip(process.env.LOOM_E2E_TRACE !== "1" || !electronApp, "isolated trace-enabled build required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	await electronApp!.evaluate(({ ipcMain, BrowserWindow }) => {
		let generation = 0;
		ipcMain.removeHandler("loom:getDevTraceConversations"); ipcMain.removeHandler("loom:getDevTraceConversation");
		ipcMain.handle("loom:getDevTraceConversations", () => [{ id: "1", at: Date.now(), count: 1, status: "completed", title: generation === 2 ? "UPDATED_TITLE" : generation ? "NEW_LIBRARY" : "OLD_LIBRARY" }]);
		ipcMain.handle("loom:getDevTraceConversation", async () => {
			const captured = generation;
			if (!captured) await new Promise((resolve) => setTimeout(resolve, 600));
			const id = captured ? "new-record" : "old-record", at = Date.now();
			return [{ id, threadId: "1", at, revision: 1, status: "completed", spans: [{ id: `${id}-span`, traceId: id, name: "pi.ai.request", startedMs: at, endedMs: at + 1, attributes: { model: "demo", "loom.io.output": JSON.stringify([{ type: "text", text: captured ? "NEW_HISTORY" : "OLD_HISTORY" }]) }, events: [], links: [], status: { status: "ok" } }] }];
		});
		ipcMain.on("loom-test-reset-source", () => { generation++; BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.webContents.send("loom:devTrace", null); });
		ipcMain.on("loom-test-live-update", () => {
			generation = 2; const at = Date.now();
			BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.webContents.send("loom:devTrace", { id: "new-record", threadId: "1", at, revision: 2, status: "completed", spans: [] });
		});
	});
	const opened = electronApp!.waitForEvent("window"); await loomPage.evaluate(() => window.loom.openDevTrace!());
	const trace = await opened; await trace.waitForLoadState();
	await expect(trace.locator(".trace-item")).toContainText("OLD_LIBRARY");
	await expect(trace.locator(".trace-history")).toContainText("加载中");
	await electronApp!.evaluate(({ ipcMain }) => { ipcMain.emit("loom-test-reset-source"); });
	await expect(trace.locator(".trace-item")).toContainText("NEW_LIBRARY");
	await expect(trace.locator(".trace-event-table")).toContainText("NEW_HISTORY");
	await trace.waitForTimeout(700);
	await expect(trace.locator(".trace-turn-header")).toHaveCount(1);
	await expect(trace.locator(".trace-event-table")).not.toContainText("OLD_HISTORY");
	await electronApp!.evaluate(({ ipcMain }) => { ipcMain.emit("loom-test-live-update"); });
	await expect(trace.locator(".trace-item")).toContainText("UPDATED_TITLE");
});

test("an older exemplar does not skip unloaded conversation history", async ({ loomPage, electronApp }) => {
	test.skip(process.env.LOOM_E2E_TRACE !== "1" || !electronApp, "isolated trace-enabled build required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	await electronApp!.evaluate(({ ipcMain }) => {
		const now = Date.now();
		const records = Array.from({ length: 100 }, (_, i) => {
			const id = `r${String(i).padStart(3, "0")}`;
			return { id, threadId: "1", at: now + i, revision: 1, status: "completed", spans: [{ id: `span-${i}`, traceId: id, name: "pi.ai.request", startedMs: now + i, endedMs: now + i + 1, attributes: { model: "demo", "loom.io.output": JSON.stringify([{ type: "text", text: `HISTORY_ROW_${i}` }]) }, events: [], links: [], status: { status: "ok" } }] };
		});
		for (const channel of ["loom:getDevTraceConversations", "loom:getDevTraceConversation", "loom:getDevTrace", "loom:getDevTraceMetrics"]) ipcMain.removeHandler(channel);
		ipcMain.handle("loom:getDevTraceConversations", () => [{ id: "1", at: now + 99, count: 100, status: "completed", title: "Paged history" }]);
		ipcMain.handle("loom:getDevTraceConversation", (_event, _id, before?: { at: number; id: string }) => records.filter((row) => !before || row.at < before.at).slice().reverse().slice(0, 40));
		ipcMain.handle("loom:getDevTrace", (_event, id: string) => records.find((row) => row.id === id));
		ipcMain.handle("loom:getDevTraceMetrics", () => [{ name: "old-exemplar", kind: "histogram", attributes: {}, intervalMs: now, count: 1, sum: 1, min: 1, max: 1, exemplars: [{ value: 1, at: now, traceId: "r010", spanId: "span-10" }] }]);
	});
	const opened = electronApp!.waitForEvent("window"); await loomPage.evaluate(() => window.loom.openDevTrace!()); const trace = await opened; await trace.waitForLoadState();
	await expect(trace.locator(".trace-turn-header")).toHaveCount(40);
	await trace.getByRole("tab", { name: "Metrics", exact: true }).click(); await trace.getByRole("row").filter({ hasText: "old-exemplar" }).locator("summary").click();
	await trace.getByRole("button", { name: /^Trace ·/ }).click(); await expect(trace.locator(".trace-io")).toContainText("HISTORY_ROW_10");
	await trace.getByRole("button", { name: "加载更早轮次", exact: true }).click(); await expect(trace.locator(".trace-turn-header")).toHaveCount(81);
	await expect(trace.locator(".trace-event-table")).toContainText("HISTORY_ROW_50");
	await trace.getByRole("button", { name: "加载更早轮次", exact: true }).click(); await expect(trace.locator(".trace-turn-header")).toHaveCount(100);
	await expect(trace.getByRole("button", { name: "加载更早轮次", exact: true })).toHaveCount(0);
});

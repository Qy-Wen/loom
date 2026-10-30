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
	const turn: DevTraceRecord = { id: "ledger-1", threadId: "1", at, revision: 1, status: "completed", spans: [
		{ id: "ledger-submit", traceId: "ledger-1", name: "pi.durable.submit", startedMs: at, endedMs: at + 1, attributes: { "submission.type": "input" }, events: [], links: [], status: { status: "ok" } },
		{ id: "ledger-phase", traceId: "ledger-1", parentId: "ledger-submit", name: "pi.durable.phase", startedMs: at + 1, endedMs: at + 501, attributes: { "task.name": "pi.generation", phase: "request", attempt: 1, outcome: "waiting" }, events: [], links: [], status: { status: "ok" } },
		{ id: "ledger-model", traceId: "ledger-1", parentId: "ledger-phase", name: "pi.ai.request", startedMs: at + 10, endedMs: at + 500, attributes: { model: "demo", "loom.io.input": JSON.stringify([{ role: "system", sections: { preamble: "SYSTEM_PROMPT", instructions: "当前素材库上下文" } }, { role: "user", content: "帮我看看目录" }]), "loom.io.output": JSON.stringify([{ type: "thinking", thinking: "先检查目录。" }, { type: "text", text: "**找到两个文件**\n\n- a.md\n- b.png\n\n![remote](https://example.invalid/private-image)\n\n<script>window.TRACE_UNSAFE=true</script>" }]) }, events: [{ name: "pi.ai.first_chunk", timeMs: 100, attributes: {} }], links: [], status: { status: "ok" } },
		{ id: "ledger-tool", traceId: "ledger-1", parentId: "ledger-submit", name: "pi.durable.phase", startedMs: at + 500, endedMs: at + 520, attributes: { "task.name": "pi.tool", "tool.name": "bash", phase: "call", "loom.io.input": '{"command":"ls"}', "loom.io.output": JSON.stringify([{ type: "text", text: 'a.md b.png\n---\n  157\n<script>unsafe</script>\n**not bold**' }]) }, events: [], links: [], status: { status: "ok" } },
	] };
	const publish = (record: DevTraceRecord) => electronApp!.evaluate(({ BrowserWindow }, record) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Traces")!.webContents.send("loom:devTrace", record), record);
	await publish(turn);
	await publish({ ...turn, id: "ledger-2", at: at + 1000, spans: turn.spans.map((span) => ({ ...span, id: `second-${span.id}`, traceId: "ledger-2" })) });
	await publish({ ...turn, id: "ledger-other", threadId: "2", at: at + 2000, spans: turn.spans.map((span) => ({ ...span, id: `other-${span.id}`, traceId: "ledger-other" })) });
	await expect(trace.locator(".trace-item")).toHaveCount(2);
	await trace.locator(".trace-item").last().click();
	await expect(trace.locator(".trace-turn-header")).toHaveCount(2);
	await expect(trace.locator('.trace-event[data-kind="system"]')).toHaveCount(1);
	await expect(trace.locator('.trace-event[data-kind="user"]')).toHaveCount(2);
	await expect(trace.locator('.trace-event[data-kind="phase"]')).toHaveCount(0);
	await expect(trace.locator('.trace-event[data-kind="tool"]').first()).toContainText("→ a.md b.png");
	await trace.locator('.trace-event[data-kind="assistant"]').first().click();
	await expect(trace.locator(".trace-request-number")).toHaveCount(0);
	await expect(trace.locator(".trace-details-header")).not.toContainText(/#\d+/);
	await expect(trace.getByRole("tab", { name: "预览", exact: true })).toHaveAttribute("aria-selected", "true");
	await expect(trace.locator(".trace-io strong")).toHaveText("找到两个文件");
	await expect(trace.locator(".trace-io img")).toHaveCount(0); await expect(trace.locator(".trace-io script")).toHaveCount(0);
	await expect(trace.getByRole("button", { name: /^思考/ })).toHaveAttribute("aria-expanded", "true");
	await trace.getByRole("button", { name: /^思考/ }).click(); await expect(trace.locator(".trace-thinking")).not.toContainText("先检查目录。");
	await trace.getByRole("tab", { name: "概述", exact: true }).click(); await expect(trace.locator(".trace-io")).toContainText("首 chunk");
	await trace.getByRole("tab", { name: "原始内容", exact: true }).click();
	await expect(trace.getByRole("heading", { name: "元数据与事件", exact: true })).toBeVisible();
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
	await publish({ ...turn, revision: 2 }); await expect(trace.locator('.trace-event[data-kind="tool"]')).toHaveCount(0);
	await toolbar.getByRole("button", { name: "⊞ 展开调用", exact: true }).click(); await expect(trace.locator('.trace-event[data-kind="tool"]')).toHaveCount(2);
	await toolbar.getByRole("button", { name: "⊟ 收起轮次", exact: true }).click(); await expect(trace.locator(".trace-event")).toHaveCount(0);
	await trace.getByRole("searchbox", { name: "搜索轨迹" }).fill("bash"); await expect(trace.locator('.trace-event[data-kind="tool"]')).toHaveCount(2);
	await trace.getByRole("searchbox", { name: "搜索轨迹" }).fill("NO_MATCH_ANYWHERE"); await expect(trace.getByText("没有匹配事件", { exact: true })).toBeVisible();
	await trace.getByRole("searchbox", { name: "搜索轨迹" }).fill("");
	await toolbar.getByRole("button", { name: "⊞ 展开轮次", exact: true }).click();
	await trace.locator('.trace-overview-block.kind-tool').first().press("Enter"); await expect(trace.locator(".trace-event.is-selected")).toHaveAttribute("data-kind", "tool");
	await expect(trace.locator(".trace-tool-output")).toHaveText('a.md b.png\n---\n  157\n<script>unsafe</script>\n**not bold**');
	await expect(trace.locator(".trace-io h2, .trace-io script, .trace-io strong")).toHaveCount(0);
	const outputStyle = await trace.locator(".trace-tool-output").evaluate((element) => ({ fontSize: getComputedStyle(element).fontSize, whiteSpace: getComputedStyle(element).whiteSpace }));
	expect(outputStyle).toEqual({ fontSize: "12px", whiteSpace: "pre-wrap" });
	await publish({ ...turn, revision: 3, spans: turn.spans.map((span) => span.id === "ledger-tool" ? { ...span, attributes: { ...span.attributes, "loom.io.output": '{"files":["a.md","b.png"]}' } } : span) });
	await expect(trace.locator(".trace-tool-output")).toHaveCount(0);
	await expect(trace.locator(".trace-io section").filter({ has: trace.getByRole("heading", { name: "结果", exact: true }) }).locator(".trace-json")).toContainText('"files"');
	await toolbar.getByRole("button", { name: "◷ 时长", exact: true }).click(); await expect(toolbar.getByRole("button", { name: "◷ 时长", exact: true })).toHaveAttribute("aria-pressed", "true");
	const box = (await trace.locator(".trace-overview-track").boundingBox())!;
	await trace.mouse.move(box.x + box.width * .1, box.y + 10); await trace.mouse.down(); await trace.mouse.move(box.x + box.width * .3, box.y + 10, { steps: 6 }); await trace.mouse.up();
	await expect(trace.getByRole("button", { name: "清除范围", exact: true })).toBeVisible(); await expect(trace.locator(".trace-overview-range")).toBeVisible();
	await trace.locator(".trace-overview-track").press("Escape"); await expect(trace.locator(".trace-overview-range")).toHaveCount(0);
	await trace.getByRole("button", { name: "关闭详情", exact: true }).click(); await expect(trace.locator(".trace-event-details")).toHaveCount(0);
	await trace.locator(".trace-item").first().click(); await expect(trace.locator(".trace-turn-header")).toHaveCount(1);
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

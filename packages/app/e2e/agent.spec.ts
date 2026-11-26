import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, saveChatEndpoint, test } from "./loom.ts";

function reply(response: ServerResponse, tool?: string, args = {}) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const delta = tool ? { tool_calls: [{ index: 0, id: `call-${tool}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: "Generated and saved the result." };
	response.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}

test("tool cards summarize results and copy each section independently", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated user data and library required");
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const { messages } = JSON.parse(body) as { messages: Array<{ role: string }> };
			const done = messages.some((message) => message.role === "tool");
			const delta = done ? { content: "Finished both reads." } : {
				tool_calls: ["visible.txt", "missing.txt"].map((path, index) => ({
					index, id: `read-${index}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path }) },
				})),
			};
			response.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "read", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			response.end(chunk(delta, null) + chunk({}, done ? "stop" : "tool_calls") + "data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
		await writeFile(join(root, "visible.txt"), Array.from({ length: 60 }, (_, index) => `Result line ${index + 1}`).join("\n"));
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBeGreaterThan(0);
		const composer = loomPage.getByRole("textbox");
		await composer.fill("Read both example files");
		await loomPage.getByRole("button", { name: "Send", exact: true }).click();
		await expect(loomPage.getByText("Finished both reads.", { exact: true })).toBeVisible();

		const success = loomPage.locator('.agui-tool-card[data-state="done"]');
		const failure = loomPage.locator('.agui-tool-card[data-state="failed"]');
		await expect(success).toHaveCount(1);
		await expect(success).not.toHaveAttribute("open", "");
		await expect(failure).toHaveAttribute("open", "");
		await expect(failure).toHaveCSS("overflow", "clip");
		await expect(failure).not.toHaveCSS("border-top-left-radius", "0px");
		await expect(failure.locator("summary")).toContainText("Failed");
		await expect(failure.locator(".agui-tool-result")).toContainText("missing.txt");
		await expect(success.locator("time")).toHaveAttribute("datetime", /^PT[\d.]+S$/);
		await expect(success.locator("time")).toHaveText(/^\d+\.\ds$/);

		await success.locator("summary").press("Enter");
		await expect(success).toHaveAttribute("open", "");
		const output = success.locator(".agui-tool-result");
		await expect(output).toContainText("Result line 60");
		const section = output.locator("..");
		expect(await section.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
		const copyArgs = success.getByRole("button", { name: "Copy tool arguments" });
		await copyArgs.focus();
		await expect(copyArgs).toHaveCSS("opacity", "1");
		await loomPage.keyboard.press("Enter");
		const clipboard = () => electronApp!.evaluate(({ clipboard }) => clipboard.readText());
		await expect.poll(clipboard).toBe(JSON.stringify({ path: "visible.txt" }, null, 2));
		await expect(success.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
		await success.getByRole("button", { name: "Copy tool result" }).click();
		await expect.poll(clipboard).toBe(await output.textContent());
		await expect(failure).toHaveAttribute("open", "");

		await loomPage.reload();
		await expect(success).not.toHaveAttribute("open", "");
		await expect(success.locator("time")).toHaveAttribute("datetime", /^PT[\d.]+S$/);
		await expect(failure).toHaveAttribute("open", "");
	} finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("tool elapsed time starts after approval and continues after reload", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated user data and library required");
	test.setTimeout(60_000);
	const release = "release-tool.txt";
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const parsed = JSON.parse(body) as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string }> };
			if (parsed.messages.some((message) => message.role === "tool")) { reply(response); return; }
			const powershell = parsed.tools?.some((tool) => tool.function.name === "powershell");
			const command = powershell
				? `while (!(Test-Path '${release}')) { Start-Sleep -Milliseconds 100 }; Write-Output ready`
				: `while [ ! -f '${release}' ]; do sleep 0.1; done; printf ready`;
			reply(response, powershell ? "powershell" : "bash", { command, timeout: 30 });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await loomPage.evaluate(() => window.loom.setAgentPermission("basic"));
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBeGreaterThan(0);
		await loomPage.getByRole("textbox").fill("Wait for the fixture to be released");
		await loomPage.getByRole("button", { name: "Send", exact: true }).click();
		const card = loomPage.locator(".agui-tool-card");
		const time = card.locator("time");
		const approve = card.getByRole("button", { name: "Approve", exact: true });
		await expect(approve).toBeVisible();
		await expect(time).toHaveCount(0);
		await approve.click();
		await expect(time).toHaveText(/^\d+s$/);
		await expect(time).toHaveAttribute("datetime", /^PT\d+S$/);
		await expect(time).toHaveAttribute("title", "Elapsed");
		const seconds = async () => Number.parseInt(await time.textContent() ?? "", 10);
		const initial = await seconds();
		await expect.poll(seconds).toBeGreaterThan(initial);
		const beforeReload = await seconds();
		await loomPage.reload();
		await expect(time).toHaveAttribute("title", "Elapsed");
		await expect(approve).toHaveCount(0);
		await expect.poll(seconds).toBeGreaterThanOrEqual(beforeReload);
		await expect.poll(seconds).toBeGreaterThan(beforeReload);
		await expect(time).toHaveText(/^\d+s$/);
		await writeFile(join(root, release), "release");
		await expect(card).toHaveAttribute("data-state", "done");
		await expect(time).toHaveAttribute("title", "Duration");
		await expect(time).toHaveText(/^\d+\.\ds$/);
		const finished = await time.textContent();
		await expect(loomPage.getByTestId("chat-assistant-message").getByText("Generated and saved the result.", { exact: true })).toBeVisible();
		await expect(time).toHaveText(finished!);
	} finally {
		await writeFile(join(root, release), "release").catch(() => undefined);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("Electron reconnects to an owned specialist approval, restores history, and forks before the question", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const parsed = JSON.parse(body) as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string }> };
			const names = parsed.tools?.map((tool) => tool.function.name) ?? [];
			if (parsed.messages.some((message) => message.role === "tool")) reply(response);
			else if (names.includes("run_create_agent")) reply(response, "run_create_agent", { goal: "save generated.txt" });
			else reply(response, "write", { path: "generated.txt", content: "generated" });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		await saveChatEndpoint(loomPage, url);
		await loomPage.evaluate(() => window.loom.setAgentPermission("basic"));
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBeGreaterThan(0);
		const before = await loomPage.evaluate(() => window.loom.listSessions());
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(before.length + 1);
		const session = (await loomPage.evaluate(() => window.loom.listSessions())).find((row) => !before.some((prior) => prior.id === row.id))!;
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		await expect(loomPage.getByRole("tab", { name: "New session", selected: true, exact: true })).toBeVisible();
		const composer = loomPage.getByRole("textbox");
		await composer.fill("Generate a file");
		await composer.press("Enter");
		await expect(loomPage.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
		await loomPage.reload();
		await expect(loomPage.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
		const parentCard = loomPage.locator(".agui-tool-card").filter({ has: loomPage.locator(".agui-tool-name", { hasText: "run_create_agent" }) });
		const argumentsText = await parentCard.locator(".agui-tool-arguments").innerText();
		expect(JSON.parse(argumentsText.replace(/^arguments\s*/, ""))).toEqual({ goal: "save generated.txt" });
		await loomPage.getByRole("button", { name: "Approve", exact: true }).click();
		const assistantReply = loomPage.getByTestId("chat-assistant-message").getByText("Generated and saved the result.", { exact: true });
		await expect(assistantReply).toBeVisible();
		const record = await loomPage.evaluate((id) => window.loom.getSession(id), session.id);
		expect(record.messages.filter((message) => message.role === "user")).toHaveLength(1);
		const root = await loomPage.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
		expect(await readFile(join(root!, "generated.txt"), "utf8")).toBe("generated");
		await loomPage.reload();
		await expect(assistantReply).toBeVisible();
		const first = record.messages.find((message) => message.role === "user")!;
		const fork = await loomPage.evaluate(({ id, entry }) => window.loom.branchBefore(id, entry), { id: record.id, entry: String(first.id) });
		expect(fork.title).toBe(record.title);
		expect(fork.messages).toEqual([]);
		expect((await loomPage.evaluate(() => window.loom.listSessions())).some((row) => row.id === record.id)).toBe(false);
	} finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("chat offers only /compact and keeps the full transcript", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated user data and library required");
	const finishSummary = Promise.withResolvers<void>();
	const turns: unknown[] = [];
	let summaries = 0;
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (part: string) => { body += part; });
		request.on("end", () => {
			const { messages } = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
			const summary = JSON.stringify(messages[0]?.content).includes("context summarization assistant");
			if (summary) summaries++;
			else turns.push(messages.findLast((message) => message.role === "user")?.content);
			const content = summary ? "Earlier chat summarized." : turns.length === 1 ? "history ".repeat(16_000) : "Recent reply.";
			const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "slash", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			const finish = () => response.end(chunk({ content }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
			if (summary) void finishSummary.promise.then(finish);
			else finish();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		const newSession = loomPage.getByRole("button", { name: "New session", exact: true });
		await expect(newSession).toBeEnabled();
		const list = () => loomPage.evaluate(() => window.loom.listSessions());
		const before = await list();
		const editor = loomPage.getByTestId("chat-composer-editor");
		const submit = async (text: string) => {
			await editor.fill(text);
			await expect(loomPage.getByTestId("chat-send-button")).toBeEnabled();
			await editor.press("Enter");
		};
		await newSession.click();
		await expect.poll(async () => (await list()).length).toBe(before.length + 1);
		await expect(newSession).toBeEnabled();
		const session = (await list()).find((row) => !before.some((item) => item.id === row.id))!;
		const record = () => loomPage.evaluate((id) => window.loom.getSession(id), session.id);
		await expect(editor).toBeEmpty();
		await editor.fill("/");
		const commands = loomPage.getByRole("listbox", { name: "Chat commands" });
		const compactCommand = commands.getByRole("option", { name: "/compact Compact context" });
		await expect(commands.getByRole("option")).toHaveCount(1);
		const option = (await compactCommand.boundingBox())!;
		expect(option.y + option.height).toBeLessThan((await editor.boundingBox())!.y);
		await expect(compactCommand).toHaveAttribute("aria-selected", "true");
		await expect(editor).toBeFocused();
		await editor.press("Escape");
		await expect(commands).toBeHidden();
		await expect(editor).toHaveText("/");
		await editor.fill("/n");
		await expect(commands).toBeHidden();
		await editor.fill("/c");
		await expect(commands.getByRole("option")).toHaveCount(1);
		await expect(compactCommand).toHaveAttribute("aria-selected", "true");
		await editor.dispatchEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229 });
		await expect(compactCommand).toBeVisible();
		await editor.press("Enter");
		await expect(loomPage.getByText("No context was compacted.")).toBeVisible();
		expect(turns).toHaveLength(0);

		await submit("First question");
		await expect.poll(async () => (await record()).messages.length).toBe(2);
		await submit("/new");
		await expect.poll(async () => (await record()).messages.length).toBe(4);
		expect(summaries).toBe(0);
		expect(JSON.stringify(turns.at(-1))).toContain("/new");
		expect(await list()).toHaveLength(before.length + 1);
		const original = await record();
		const tab = loomPage.getByRole("tab", { selected: true });
		await expect(tab).toHaveAttribute("aria-description", "Idle");
		await submit("/compact");
		await expect(tab).toHaveAttribute("aria-description", "Busy");
		finishSummary.resolve();
		await expect(loomPage.getByText("Context compacted.")).toBeVisible();
		await expect(tab).toHaveAttribute("aria-description", "Idle");
		const compacted = await record();
		expect(summaries).toBe(1);
		expect(turns).toHaveLength(2);
		expect(compacted.messages).toEqual(original.messages);
		expect(compacted.context!.tokens).toBeLessThan(original.context!.tokens!);
		await expect(loomPage.getByTestId("chat-message-list").getByText("First question", { exact: true })).toBeVisible();
	} finally {
		finishSummary.resolve();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("Electron retains pre-compaction chat after reload and can fork before an old question", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	test.setTimeout(60_000);
	const answers = ["OLD_HISTORY_REPLY", "RECENT_HISTORY_REPLY", "AFTER_COMPACTION_REPLY"];
	let summaries = 0; let turns = 0; let lastAnswerContext = "";
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
			const summary = JSON.stringify(parsed.messages[0]?.content).includes("context summarization assistant");
			let text: string;
			if (summary) { summaries++; text = "Earlier history summarized."; }
			else { lastAnswerContext = JSON.stringify(parsed.messages); const index = turns++; text = `${answers[index] ?? "Unexpected extra request"}${index < 2 ? `\n${"padding ".repeat(16_000)}` : ""}`; }
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`data: ${JSON.stringify({ id: "history", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "history", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, { contextWindow: 50_000 });
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBeGreaterThan(0);
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		const before = await loomPage.evaluate(() => window.loom.listSessions());
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(before.length + 1);
		const session = (await loomPage.evaluate(() => window.loom.listSessions())).find((row) => !before.some((prior) => prior.id === row.id))!;
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		await expect(loomPage.getByRole("tab", { name: "New session", selected: true, exact: true })).toBeVisible();
		const contextSizes: number[] = [];
		for (let i = 0; i < 3; i++) {
			await loomPage.getByRole("textbox").fill(`HISTORY_QUESTION_${i}`); await loomPage.getByRole("textbox").press("Enter");
			await expect.poll(async () => (await loomPage.evaluate((id) => window.loom.getSession(id), session.id)).messages.filter((message) => message.role === "assistant").length).toBe(i + 1);
			contextSizes.push((await loomPage.evaluate((id) => window.loom.getSession(id), session.id)).context!.tokens!);
		}
		expect(summaries).toBeGreaterThan(0); expect(turns).toBe(3);
		expect(lastAnswerContext).not.toContain("HISTORY_QUESTION_1");
		expect(contextSizes[2]!).toBeLessThan(contextSizes[1]!);
		await loomPage.reload();
		await expect(loomPage.getByTestId("chat-message-list").getByText("HISTORY_QUESTION_0", { exact: true })).toBeVisible();
		await expect(loomPage.getByText(/OLD_HISTORY_REPLY/)).toBeVisible();
		const record = await loomPage.evaluate((id) => window.loom.getSession(id), session.id);
		expect(record.messages).toHaveLength(6);
		await loomPage.getByRole("button", { name: "Context usage", exact: true }).click();
		await expect(loomPage.locator(".session-context-value")).toHaveText(`~${record.context!.percent!.toFixed(1)}% / 50k`);
		const oldQuestion = record.messages.filter((message) => message.role === "user")[1]!;
		const fork = await loomPage.evaluate(({ id, entry }) => window.loom.branchBefore(id, entry), { id: session.id, entry: String(oldQuestion.id) });
		expect(fork.messages.map((message) => message.id)).toEqual(record.messages.slice(0, 2).map((message) => message.id));
		expect(JSON.stringify(fork.messages)).toContain("OLD_HISTORY_REPLY");
		expect((await loomPage.evaluate(() => window.loom.listSessions())).some((row) => row.id === session.id)).toBe(false);
	} finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

for (const editedQuestion of ["OLD_QUESTION", "KEEP_QUESTION"] as const) {
test(`editing ${editedQuestion} sends once on the new branch and streams before completion`, async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated library required");
	const finish = Promise.withResolvers<void>();
	const requests: string[][] = [];
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const messages = (JSON.parse(body) as { messages: Array<{ role: string; content: string }> }).messages;
			requests.push(messages.filter((message) => message.role === "user").map((message) => message.content));
			const edited = JSON.stringify(messages).includes("EDITED_QUESTION");
			const text = edited ? "EDITED_REPLY_PARTIAL" : `ANSWER_${requests.length}`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (content: string, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: "edit", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
			response.write(chunk(text));
			if (edited) void finish.promise.then(() => response.end(chunk(" finished", "stop") + "data: [DONE]\n\n"));
			else response.end(chunk("", "stop") + "data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		for (const [index, question] of ["KEEP_QUESTION", "OLD_QUESTION", "LATER_QUESTION"].entries()) {
			await loomPage.getByRole("textbox").fill(question); await loomPage.getByRole("textbox").press("Enter");
			await expect(loomPage.getByText(`ANSWER_${index + 1}`, { exact: true })).toBeVisible();
		}
		const source = (await loomPage.evaluate(() => window.loom.listSessions())).filter((row) => row.title === "KEEP_QUESTION").sort((a, b) => b.createdAt - a.createdAt)[0]!;
		const original = await loomPage.evaluate((id) => window.loom.getSession(id), source.id);
		const bubble = loomPage.getByTestId("chat-user-message").filter({ hasText: editedQuestion });
		await bubble.getByText(editedQuestion, { exact: true }).hover(); await bubble.getByRole("button", { name: "Edit", exact: true }).click();
		await loomPage.getByRole("textbox", { name: "Edit question", exact: true }).fill("EDITED_QUESTION");
		await loomPage.locator(".session-inline-edit").getByRole("button", { name: "Send", exact: true }).click();
		await expect.poll(() => requests.length).toBe(4);
		expect(JSON.stringify(requests[3])).not.toMatch(/OLD_QUESTION|LATER_QUESTION/);
		await expect(loomPage.getByText("EDITED_REPLY_PARTIAL", { exact: true })).toBeVisible();
		// Editing replaces the conversation: one listed session with the same title, and the source is gone from the lists.
		// Sessions from an earlier case in this run are also titled KEEP_QUESTION, so look only at this one's.
		const listed = (await loomPage.evaluate(() => window.loom.listSessions())).filter((row) => row.title === "KEEP_QUESTION" && row.createdAt >= source.createdAt);
		expect(listed).toHaveLength(1);
		const branch = listed[0]!;
		expect(branch.id).not.toBe(source.id);
		const expectedUsers = editedQuestion === "OLD_QUESTION" ? ["KEEP_QUESTION", "EDITED_QUESTION"] : ["EDITED_QUESTION"];
		expect(requests[3]).toEqual(expectedUsers);
		finish.resolve(); await expect(loomPage.getByText("EDITED_REPLY_PARTIAL finished", { exact: true })).toBeVisible();
		const record = await loomPage.evaluate((id) => window.loom.getSession(id), branch.id);
		expect(record.messages.filter((message) => message.role === "user").map((message) => message.displayContent)).toEqual(expectedUsers);
		expect((await loomPage.evaluate((id) => window.loom.getSession(id), source.id)).messages).toEqual(original.messages);
		expect((await loomPage.evaluate(() => window.loom.listSessions())).some((row) => row.id === source.id)).toBe(false);
		await loomPage.reload(); await expect(loomPage.getByText("EDITED_REPLY_PARTIAL finished", { exact: true })).toBeVisible();
		expect(requests).toHaveLength(4);
	} finally { finish.resolve(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
}

test("Electron streams successive turns after reasoning and durable user admission", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	const releases = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
	const nextChunks = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
	let requests = 0;
	const server = createServer((_request, response) => {
		const turn = requests++;
		response.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: `turn-${turn}`, object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
		response.write(chunk({ reasoning_content: `Reasoning for turn ${turn}` }));
		response.write(chunk({ content: `STREAM_TURN_${turn}_PARTIAL` }));
		void nextChunks[turn]!.promise.then(() => response.write(chunk({ content: " plus another chunk" })));
		void releases[turn]!.promise.then(() => response.end(chunk({ content: " and finished" }, "stop") + "data: [DONE]\n\n"));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBeGreaterThan(0);
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		const before = await loomPage.evaluate(() => window.loom.listSessions());
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(before.length + 1);
		const session = (await loomPage.evaluate(() => window.loom.listSessions())).find((row) => !before.some((prior) => prior.id === row.id))!;
		await expect(loomPage.getByRole("button", { name: "New session", exact: true })).toBeEnabled();
		for (let turn = 0; turn < 3; turn++) {
			await loomPage.getByRole("textbox").fill(`Stream question ${turn}`); await loomPage.getByRole("textbox").press("Enter");
			await expect.poll(() => requests).toBe(turn + 1);
			// The provider cannot finish until visible partial text passes this assertion.
			await expect(loomPage.getByTestId("chat-message-list").getByText(`STREAM_TURN_${turn}_PARTIAL`, { exact: true })).toBeVisible();
			const pending = await loomPage.evaluate((id) => window.loom.getSession(id), session.id);
			expect(pending.messages.filter((message) => message.role === "user")).toHaveLength(turn + 1);
			expect(pending.messages.filter((message) => message.role === "assistant")).toHaveLength(turn);
			nextChunks[turn]!.resolve();
			await expect(loomPage.getByText(`STREAM_TURN_${turn}_PARTIAL plus another chunk`, { exact: true })).toBeVisible();
			releases[turn]!.resolve();
			await expect(loomPage.getByText(`STREAM_TURN_${turn}_PARTIAL plus another chunk and finished`, { exact: true })).toBeVisible();
			await expect.poll(async () => (await loomPage.evaluate((id) => window.loom.getSession(id), session.id)).messages.filter((message) => message.role === "assistant").length).toBe(turn + 1);
		}
	} finally { for (const next of nextChunks) next.resolve(); for (const release of releases) release.resolve(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("Electron shows partial text before the model finishes streaming", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated user data and library required");
	const finish = Promise.withResolvers<void>();
	let providerFinished = false;
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (content: string, finishReason: string | null = null) => `data: ${JSON.stringify({ id: "stream", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content }, finish_reason: finishReason }], ...(finishReason ? { usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } } : {}) })}\n\n`;
		response.write(chunk("First words before completion"));
		void finish.promise.then(() => { providerFinished = true; response.end(chunk(" and final words", "stop") + "data: [DONE]\n\n"); });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBeGreaterThan(0);
		const count = (await loomPage.evaluate(() => window.loom.listSessions())).length;
		await loomPage.getByRole("button", { name: "New session", exact: true }).click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(count + 1);
		await expect(loomPage.getByRole("tab", { name: "New session", selected: true, exact: true })).toBeVisible();
		const indicator = loomPage.getByRole("button", { name: "Context usage", exact: true });
		await expect(indicator).toBeVisible(); await indicator.click();
		await expect(loomPage.locator(".session-context-value")).toHaveText("~0.0% / 128k");
		await indicator.click();
		const composer = loomPage.getByRole("textbox");
		await composer.fill("Test streaming"); await composer.press("Enter");
		await expect(loomPage.getByText("First words before completion", { exact: true })).toBeVisible({ timeout: 5000 });
		expect(providerFinished).toBe(false);
		finish.resolve();
		await expect(loomPage.getByText("First words before completion and final words", { exact: true })).toBeVisible();
		await indicator.click();
		await expect(loomPage.locator(".session-context-value")).toHaveText("~0.8% / 128k");
		await loomPage.reload(); await indicator.click();
		await expect(loomPage.locator(".session-context-value")).toHaveText("~0.8% / 128k");
		await loomPage.evaluate(async () => {
			const view = await window.loom.getChatSettings();
			await window.loom.saveChatSettings({ ...view.config, default: { ...view.config.default!, thinkingLevel: "off" } });
		});
		// Remembered choices affect new conversations; this conversation keeps its context window.
		await expect(loomPage.locator(".session-context-value")).toHaveText("~0.8% / 128k");
		await loomPage.evaluate(async () => {
			const view = await window.loom.getChatSettings();
			delete view.config.default;
			await window.loom.saveChatSettings(view.config);
		});
		await expect(indicator).toBeVisible();
		await expect(loomPage.locator(".session-context-value")).toHaveText("~0.8% / 128k");
	} finally { finish.resolve(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("identical queued follow-ups are admitted once each and stop showing as queued", async ({ loomPage }) => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated library required");
	const releases = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
	let requests = 0;
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			const turn = requests++;
			const chunk = (content: string, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: `queued-${turn}`, object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(chunk(`QUEUED_PARTIAL_${turn}`));
			void (releases[turn]?.promise ?? Promise.resolve()).then(() => response.end(chunk(" complete", "stop") + "data: [DONE]\n\n"));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await saveChatEndpoint(loomPage, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		const create = loomPage.getByRole("button", { name: "New session", exact: true });
		await create.click();
		// The old empty session has the same title; wait for the new session to finish activating.
		await expect(create).toBeEnabled();
		await expect(loomPage.getByRole("tab", { name: "New session", exact: true, selected: true })).toBeVisible();
		const composer = loomPage.getByRole("textbox");
		await composer.fill("Start queued follow-up test"); await composer.press("Enter");
		await expect(loomPage.getByText("QUEUED_PARTIAL_0", { exact: true })).toBeVisible();
		for (let index = 0; index < 2; index++) {
			await composer.fill("Same queued question"); await composer.press("Enter");
			await expect(loomPage.locator(".session-follow-up li")).toHaveCount(index + 1);
		}
		for (let turn = 0; turn < 3; turn++) {
			await expect(loomPage.getByText(`QUEUED_PARTIAL_${turn}`, { exact: true })).toBeVisible();
			await expect(loomPage.locator(".session-follow-up li")).toHaveCount(Math.max(0, 2 - turn));
			releases[turn]!.resolve();
			await expect(loomPage.getByText(`QUEUED_PARTIAL_${turn} complete`, { exact: true })).toBeVisible();
		}
		await expect(loomPage.getByTestId("chat-user-message").filter({ hasText: "Same queued question" })).toHaveCount(2);
		expect(requests).toBe(3);
	} finally {
		for (const release of releases) release.resolve();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

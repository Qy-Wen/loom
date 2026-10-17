import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { BACKGROUND_CONTEXT as context } from "@loom/agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { LibraryAgentHost } from "../src/main/library-agent-host.ts";
import { launchTestElectron, saveChatEndpoint } from "./loom.ts";

test("large saved tool results do not duplicate user bubbles or interrupt subsequent streamed replies", async () => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated library required");
	test.setTimeout(60_000);
	const directory = await mkdtemp(join(tmpdir(), "loom-large-chat-"));
	const library = join(directory, "library");
	const userData = join(directory, "user-data");
	const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	let requests = 0;
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			const turn = requests++;
			const chunk = (content: string, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: `large-${turn}`, object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(`data: ${JSON.stringify({ id: `large-${turn}`, object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { reasoning_content: `History reasoning ${turn}` }, finish_reason: null }] })}\n\n`);
			response.write(chunk(`LARGE_HISTORY_PARTIAL_${turn}`));
			void (releases[turn]?.promise ?? Promise.resolve()).then(() => response.end(chunk(" complete", "stop") + "data: [DONE]\n\n"));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const host = new LibraryAgentHost({ models: createModels() });
	let app: Awaited<ReturnType<typeof launchTestElectron>> | undefined;
	try {
		await mkdir(library);
		await mkdir(userData);
		await host.openLibrary(library);
		const session = await host.createSession();
		await host.setSessionName(session.id, "Large history");
		const conversation = await host.conversation(session.id);
		await conversation.commit(async (tx) => {
			await tx.appendEntry(conversation.id, { kind: "loom.user", data: { text: "Earlier question" }, model: [{ role: "user", content: "Earlier question", timestamp: 1 }] });
			await tx.appendEntry(conversation.id, { kind: "test.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "old-call", name: "legacy_tool", arguments: {} }], api: "openai-completions", provider: "loom-chat", model: "demo", stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 2 }] });
			await tx.appendEntry(conversation.id, { kind: "test.tool", model: [{ role: "toolResult", toolCallId: "old-call", toolName: "legacy_tool", content: [{ type: "text", text: "x".repeat(11 * 1024 * 1024) }], isError: false, timestamp: 3 }] });
		}, context);
		await host.close();
		await writeFile(join(userData, "last-library.json"), JSON.stringify({ rootPath: library }));
		await writeFile(join(userData, "general.json"), JSON.stringify({ language: "en", reopenLastLibrary: true }));
		app = await launchTestElectron(userData);
		const page = await app.firstWindow();
		const errors: string[] = [];
		const outgoing: Array<Array<{ role: string; content: unknown }>> = [];
		const streamSizes: number[] = [];
		page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
		page.on("request", (request) => {
			if (new URL(request.url()).pathname.endsWith("/run")) outgoing.push(request.postDataJSON().messages);
		});
		page.on("response", (response) => {
			if (response.headers()["content-type"]?.includes("text/event-stream")) void response.body().then((body) => streamSizes.push(body.length)).catch(() => {});
		});
		await expect(page.getByRole("tab", { name: "Large history", selected: true, exact: true })).toBeVisible();
		await saveChatEndpoint(page, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, { contextWindow: 100_000_000 });
		await page.evaluate((id) => window.loom.setSessionModel(id, { provider: "e2e-chat", modelId: "demo", thinkingLevel: "off" }), session.id);
		const question = "Ask the same question again";
		const bubbles = page.getByTestId("copilot-user-message").filter({ hasText: question });
		for (let turn = 0; turn < 2; turn++) {
			await page.getByRole("textbox").fill(question);
			await page.getByRole("textbox").press("Enter");
			await expect.poll(() => requests).toBe(turn + 1);
			await expect(page.getByText(`LARGE_HISTORY_PARTIAL_${turn}`, { exact: true })).toBeVisible();
			await expect(bubbles).toHaveCount(turn + 1);
			if (turn === 0) {
				await page.getByRole("button", { name: "New session", exact: true }).click();
				await expect(page.getByRole("tab", { name: "New session", selected: true, exact: true })).toBeVisible();
				await expect(page.getByTestId("copilot-message-list")).toHaveText("");
				await page.getByRole("tab", { name: "Large history", exact: true }).click();
				await expect(page.getByText("LARGE_HISTORY_PARTIAL_0", { exact: true })).toBeVisible();
				await expect(bubbles).toHaveCount(1);
			}
			releases[turn]!.resolve();
			await expect(page.getByText(`LARGE_HISTORY_PARTIAL_${turn} complete`, { exact: true })).toBeVisible();
			await expect(bubbles).toHaveCount(turn + 1);
		}
		await page.getByRole("button", { name: "New session", exact: true }).click();
		await expect(page.getByRole("tab", { name: "New session", selected: true, exact: true })).toBeVisible();
		await page.getByRole("tab", { name: "Large history", exact: true }).click();
		await expect(bubbles).toHaveCount(2);
		await expect(page.getByText("LARGE_HISTORY_PARTIAL_1 complete", { exact: true })).toBeVisible();
		expect(errors.filter((error) => /SSE buffer|agent_run_failed|agent_connect_failed/.test(error))).toEqual([]);
		expect(requests).toBe(2);
		expect(outgoing).toHaveLength(2);
		for (const messages of outgoing) expect(messages).toEqual([expect.objectContaining({ role: "user", content: question })]);
		await expect.poll(() => streamSizes.length).toBeGreaterThan(0);
		expect(Math.max(...streamSizes)).toBeLessThan(64 * 1024);
	} finally {
		for (const release of releases) release.resolve();
		await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
		await app?.close().catch(() => {});
		await host.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

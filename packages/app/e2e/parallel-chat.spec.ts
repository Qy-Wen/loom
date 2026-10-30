import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { launchTestElectron } from "./loom.ts";

type Lane = "ALPHA" | "BETA";
type RequestBody = { model: string; messages: Array<{ role: string; content: unknown }> };
type HeldRequest = { lane: Lane; turn: number; body: RequestBody; response: ServerResponse; path: string; auth: string | undefined };

function chunk(model: string, delta: unknown, finish_reason: string | null = null, tokens?: number): string {
	return `data: ${JSON.stringify({ id: "parallel", object: "chat.completion.chunk", model,
		choices: [{ index: 0, delta, finish_reason }],
		...(tokens ? { usage: { prompt_tokens: tokens - 10, completion_tokens: 10, total_tokens: tokens } } : {}) })}\n\n`;
}

for (const topology of ["same-provider", "different-providers"] as const) test(`parallel independent models: ${topology}`, async () => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated process, credentials and library required");
	test.setTimeout(90_000);
	const root = await mkdtemp(join(tmpdir(), "loom-parallel-chat-"));
	const library = join(root, "library"), userData = join(root, "user-data");
	const requests: HeldRequest[] = [], held: HeldRequest[] = [];
	const routingErrors: string[] = [];
	let app: ElectronApplication | undefined;
	const provider = (lane: Lane) => topology === "same-provider" ? "parallel" : `parallel-${lane.toLowerCase()}`;
	const model = (lane: Lane, switched = false) => switched ? "alpha-next" : topology === "same-provider" ? lane.toLowerCase() : "shared-model";
	const tokens = (lane: Lane, turn: number) => (lane === "ALPHA" ? 30_000 : 40_000) + turn * 100 + 10;
	const finish = (lane: Lane, turn: number) => {
		const entry = held.find((entry) => entry.lane === lane && entry.turn === turn)!;
		expect(entry, `${lane} turn ${turn} reached the server`).toBeDefined();
		if (turn === 1) {
			// Reuse the raw tool-call ID in both conversations to catch cross-session event collisions.
			entry.response.end(chunk(entry.body.model, { tool_calls: [{ index: 0, id: "shared-tool-id", type: "function",
				function: { name: "read", arguments: JSON.stringify({ path: `${lane.toLowerCase()}.txt` }) } }] }, "tool_calls") + "data: [DONE]\n\n");
		} else entry.response.end(chunk(entry.body.model, { content: ` ${lane}_TURN_${turn}_DONE` }, "stop", tokens(lane, turn)) + "data: [DONE]\n\n");
	};
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (part: string) => { body += part; });
		request.on("end", () => {
			const parsed = JSON.parse(body) as RequestBody;
			const marker = JSON.stringify(parsed.messages.filter((message) => message.role === "user").at(-1)?.content).match(/(ALPHA|BETA)_TURN_(\d+)/);
			if (!marker) { response.writeHead(400); response.end("Missing test marker"); return; }
			const lane = marker[1] as Lane, turn = Number(marker[2]);
			const path = request.url!, auth = request.headers.authorization;
			const expectedPath = topology === "same-provider" ? "/shared/chat/completions" : `/${lane.toLowerCase()}/chat/completions`;
			if (path !== expectedPath || auth !== `Bearer test-key-${provider(lane)}`) routingErrors.push(`${lane}: wrong endpoint or credentials`);
			if (parsed.model !== model(lane, lane === "ALPHA" && turn > 1)) routingErrors.push(`${lane}: wrong model ${parsed.model}`);
			const entry = { lane, turn, body: parsed, response, path, auth };
			requests.push(entry);
			if (lane === "ALPHA" && turn === 4) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "ALPHA_ONLY_FAILURE", type: "invalid_request_error" } })); return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (parsed.messages.at(-1)?.role === "tool") {
				response.end(chunk(parsed.model, { content: `${lane}_TURN_${turn}_DONE` }, "stop", tokens(lane, turn)) + "data: [DONE]\n\n");
			} else {
				held.push(entry);
				response.write(chunk(parsed.model, { content: `${lane}_TURN_${turn}_PARTIAL` }));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await mkdir(library); await mkdir(userData);
		for (const lane of ["ALPHA", "BETA"] as const) await writeFile(join(library, `${lane.toLowerCase()}.txt`), `${lane}_PRIVATE_TOOL_RESULT`);
		await writeFile(join(userData, "last-library.json"), JSON.stringify({ rootPath: library }));
		await writeFile(join(userData, "general.json"), JSON.stringify({ language: "en", reopenLastLibrary: true }));
		app = await launchTestElectron(userData);
		let page: Page = await app.firstWindow();
		await expect(page.getByRole("button", { name: "New session", exact: true })).toBeVisible();
		const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		await page.evaluate(async ({ topology, baseUrl }) => {
			const config = (await window.loom.getChatSettings()).config;
			const alpha = { id: topology === "same-provider" ? "alpha" : "shared-model", reasoning: false, input: ["text"] as "text"[], contextWindow: 64_000, maxTokens: 1024 };
			const beta = { ...alpha, id: topology === "same-provider" ? "beta" : "shared-model", contextWindow: 128_000 };
			const next = { ...alpha, id: "alpha-next", contextWindow: 96_000 };
			config.providers = topology === "same-provider"
				? [{ id: "parallel", kind: "custom", enabled: true, baseUrl: `${baseUrl}/shared`, api: "openai-completions", models: [alpha, beta, next] }]
				: [{ id: "parallel-alpha", kind: "custom", enabled: true, baseUrl: `${baseUrl}/alpha`, api: "openai-completions", models: [alpha, next] },
					{ id: "parallel-beta", kind: "custom", enabled: true, baseUrl: `${baseUrl}/beta`, api: "openai-completions", models: [beta] }];
			delete config.default;
			await window.loom.saveChatSettings(config);
			for (const provider of config.providers) {
				const unsubscribe = window.loom.onChatLoginPrompt((prompt) => {
					if (prompt.type === "secret") void window.loom.chatLoginResponse(`test-key-${provider.id}`);
				});
				try { await window.loom.chatLogin(provider.id, "api_key"); } finally { unsubscribe(); }
			}
			await window.loom.setAgentPermission("full");
		}, { topology, baseUrl });
		const ids = {} as Record<Lane, string>;
		const record = (lane: Lane) => page.evaluate((id) => window.loom.getSession(id), ids[lane]);
		const picker = () => page.getByRole("button", { name: "Conversation model", exact: true });
		const activate = async (lane: Lane) => {
			await page.getByRole("tab", { name: (await record(lane)).title, exact: true }).click();
			await expect(picker()).toHaveText(`${model(lane, lane === "ALPHA" && switched)} (${provider(lane)})`);
		};
		const send = async (lane: Lane, turn: number) => {
			await page.getByRole("textbox").fill(`${lane}_TURN_${turn}`);
			await page.getByRole("textbox").press("Enter");
			if (!(lane === "ALPHA" && turn === 4)) await expect(page.getByText(`${lane}_TURN_${turn}_PARTIAL`, { exact: true })).toBeVisible();
		};
		const done = async (lane: Lane, turn: number) => {
			await expect.poll(async () => (await record(lane)).messages.filter((row) => row.role === "assistant").at(-1)?.stopReason).toBe("stop");
			await expect.poll(async () => (await record(lane)).context?.tokens).toBe(tokens(lane, turn));
		};
		let switched = false;
		for (const lane of ["ALPHA", "BETA"] as const) {
			const before = await page.evaluate(() => window.loom.listSessions());
			await page.getByRole("button", { name: "New session", exact: true }).click();
			ids[lane] = (await page.evaluate(() => window.loom.listSessions())).find((row) => !before.some((old) => old.id === row.id))!.id;
			await picker().click();
			await page.getByRole("menuitemradio", { name: `${model(lane)} (${provider(lane)})`, exact: true }).click();
			await send(lane, 1);
		}
		expect(held).toHaveLength(2);
		expect(held.every((entry) => !entry.response.writableEnded && !entry.response.destroyed)).toBe(true);
		await page.reload();
		await activate("ALPHA");
		await expect(page.getByText("ALPHA_TURN_1_PARTIAL", { exact: true })).toBeVisible();
		await expect(page.getByText("BETA_TURN_1_PARTIAL", { exact: true })).toHaveCount(0);
		await expect(picker()).toBeDisabled();
		finish("ALPHA", 1); await done("ALPHA", 1);
		await expect(picker()).toBeEnabled();
		await picker().click();
		await page.getByRole("menuitemradio", { name: `alpha-next (${provider("ALPHA")})`, exact: true }).click();
		switched = true;
		await send("ALPHA", 2);
		expect(held.find((entry) => entry.lane === "BETA")!.response.destroyed).toBe(false);
		finish("ALPHA", 2); await done("ALPHA", 2);
		await activate("BETA");
		await expect(page.getByText("BETA_TURN_1_PARTIAL", { exact: true })).toBeVisible();
		await expect(picker()).toBeDisabled();
		finish("BETA", 1); await done("BETA", 1);
		for (const lane of ["ALPHA", "BETA"] as const) {
			const followUp = requests.find((entry) => entry.lane === lane && entry.body.messages.at(-1)?.role === "tool")!;
			expect(JSON.stringify(followUp.body.messages.at(-1))).toContain(`${lane}_PRIVATE_TOOL_RESULT`);
		}
		expect((await record("ALPHA")).messages.find((row) => row.role === "toolResult")?.toolCallId)
			.not.toBe((await record("BETA")).messages.find((row) => row.role === "toolResult")?.toolCallId);
		// Stop one stream while the other remains open and completes normally.
		await activate("ALPHA"); await send("ALPHA", 3);
		await activate("BETA"); await send("BETA", 2);
		await activate("ALPHA");
		const stop = page.getByTestId("copilot-send-button");
		await expect(stop.locator("svg.lucide-square")).toBeVisible();
		await stop.click();
		await expect.poll(async () => (await record("ALPHA")).messages.filter((row) => row.role === "assistant").at(-1)?.stopReason).toBe("aborted");
		await expect.poll(() => held.find((entry) => entry.lane === "ALPHA" && entry.turn === 3)!.response.destroyed).toBe(true);
		expect(held.find((entry) => entry.lane === "BETA" && entry.turn === 2)!.response.destroyed).toBe(false);
		finish("BETA", 2); await done("BETA", 2);
		// A terminal provider error must not stop the other conversation either.
		await activate("BETA"); await send("BETA", 3);
		await activate("ALPHA"); await send("ALPHA", 4);
		await expect.poll(async () => (await record("ALPHA")).messages.filter((row) => row.role === "assistant").at(-1)?.stopReason).toBe("error");
		expect(held.find((entry) => entry.lane === "BETA" && entry.turn === 3)!.response.destroyed).toBe(false);
		finish("BETA", 3); await done("BETA", 3);
		const saved = { ALPHA: await record("ALPHA"), BETA: await record("BETA") };
		await app.evaluate(({ app }) => app.exit(0)); await app.close(); app = undefined;
		app = await launchTestElectron(userData); page = await app.firstWindow();
		await expect(page.getByRole("button", { name: "New session", exact: true })).toBeVisible();
		for (const lane of ["ALPHA", "BETA"] as const) {
			const reopened = await record(lane);
			expect(reopened.model).toEqual(saved[lane].model);
			expect(reopened.context).toEqual(saved[lane].context);
			expect(reopened.messages).toEqual(saved[lane].messages);
			await activate(lane); await send(lane, lane === "ALPHA" ? 5 : 4);
		}
		expect(held.filter((entry) => !entry.response.destroyed && !entry.response.writableEnded)).toHaveLength(2);
		finish("BETA", 4); await done("BETA", 4);
		finish("ALPHA", 5); await done("ALPHA", 5);
		for (const lane of ["ALPHA", "BETA"] as const) {
			const other = lane === "ALPHA" ? "BETA" : "ALPHA";
			for (const entry of requests.filter((entry) => entry.lane === lane)) expect(JSON.stringify(entry.body.messages)).not.toContain(`${other}_`);
			const final = await record(lane);
			expect(final.messages.filter((row) => row.role === "user")).toHaveLength(lane === "ALPHA" ? 5 : 4);
			expect(final.context?.window).toBe(lane === "ALPHA" ? 96_000 : 128_000);
			expect(JSON.stringify(final.messages)).not.toContain(`${other}_`);
		}
		expect(requests.filter((entry) => entry.lane === "ALPHA" && entry.turn === 4)).toHaveLength(1);
		expect(routingErrors).toEqual([]);
		const alpha = await record("ALPHA"), beta = await record("BETA");
		const fork = await page.evaluate(({ id, entryId }) => window.loom.forkAfter(id, entryId), {
			id: ids.ALPHA, entryId: String(alpha.messages.filter((row) => row.role === "assistant").at(-1)!.id),
		});
		expect(fork.model).toEqual(alpha.model);
		expect(fork.context?.window).toBe(96_000);
		expect(JSON.stringify(fork.messages)).toContain("ALPHA_TURN_5_DONE");
		expect(JSON.stringify(fork.messages)).not.toContain("BETA_");
		expect(await record("BETA")).toEqual(beta);
	} finally {
		await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {});
		server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { launchTestElectron, saveChatEndpoint } from "./loom.ts";

function reply(response: ServerResponse, tool?: string, args = {}) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const delta = tool ? { tool_calls: [{ index: 0, id: `call-${tool}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: "Recovered and saved." };
	response.end(`data: ${JSON.stringify({ id: "recover", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "recover", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}

async function killElectron(app: ElectronApplication, afterKill?: () => Promise<void>): Promise<void> {
	const child = app.process();
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGKILL"); await exited;
	// A surviving tool can hold Electron's stdout pipe open on Windows.
	await afterKill?.();
	await app.close().catch(() => {});
}

test("hard-killed Electron recovers the same owned child and asks for approval again", async () => {
	test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated process and library required");
	test.setTimeout(60_000);
	const root = await mkdtemp(join(tmpdir(), "loom-crash-"));
	const library = join(root, "library"); const userData = join(root, "user-data");
	let app: ElectronApplication | undefined;
	let parentRequests = 0; let childRequests = 0;
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			const parsed = JSON.parse(body) as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string }> };
			const names = parsed.tools?.map((tool) => tool.function.name) ?? [];
			if (parsed.messages.some((message) => message.role === "tool")) reply(response);
			else if (names.includes("run_create_agent")) { parentRequests++; reply(response, "run_create_agent", { goal: "save recovered.txt" }); }
			else { childRequests++; reply(response, "write", { path: "recovered.txt", content: "recovered" }); }
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await mkdir(library); await mkdir(userData);
		await writeFile(join(userData, "last-library.json"), JSON.stringify({ rootPath: library }));
		await writeFile(join(userData, "general.json"), JSON.stringify({ language: "en", reopenLastLibrary: true }));
		app = await launchTestElectron(userData);
		let page = await app.firstWindow();
		await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
		const session = (await page.evaluate(() => window.loom.listSessions()))[0]!;
		await saveChatEndpoint(page, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await page.evaluate((id) => window.loom.setSessionModel(id, { provider: "e2e-chat", modelId: "demo", thinkingLevel: "off" }), session.id);
		await page.evaluate(() => window.loom.setAgentPermission("basic"));
		await page.getByRole("textbox").fill("Recover this task"); await page.getByRole("textbox").press("Enter");
		await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
		const childBefore = await page.locator(".tool-call").filter({ has: page.locator(".tool-call-name", { hasText: /^write$/ }) }).filter({ hasText: "waiting" }).count();
		expect(childBefore).toBe(1);
		await expect.poll(() => parentRequests).toBe(1); expect(childRequests).toBe(1);
		await expect(readFile(join(library, "recovered.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		await killElectron(app); app = undefined;
		app = await launchTestElectron(userData); page = await app.firstWindow();
		await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible({ timeout: 15_000 });
		expect(parentRequests).toBe(1); expect(childRequests).toBe(1);
		expect((await page.evaluate(() => window.loom.listSessions())).map((row) => row.id)).toEqual([session.id]);
		await page.getByRole("button", { name: "Approve", exact: true }).click();
		await expect(page.getByText("Recovered and saved.", { exact: true }).first()).toBeVisible();
		expect(await readFile(join(library, "recovered.txt"), "utf8")).toBe("recovered");
		const record = await page.evaluate((id) => window.loom.getSession(id), session.id);
		expect(record.messages.filter((message) => message.role === "user")).toHaveLength(1);
	} finally {
		await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {});
		server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});

for (const boundary of ["streaming", "unsafe-bash"] as const) {
	test(`hard-killed Electron recovers ${boundary} without duplicating user input or external effects`, async () => {
		test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated process and library required");
		test.setTimeout(60_000);
		const root = await mkdtemp(join(tmpdir(), `loom-crash-${boundary}-`));
		const library = join(root, "library"); const userData = join(root, "user-data");
		let app: ElectronApplication | undefined;
		let requests = 0;
		const modelInputs: unknown[] = [];
		const server = createServer((request, response) => {
			let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => {
				requests++;
				const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
				modelInputs.push(parsed.messages.filter((message) => message.role === "user"));
				if (boundary === "streaming") {
					if (requests > 1) { reply(response); return; }
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.write(`data: ${JSON.stringify({ id: "partial", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content: "Unfinished before crash" }, finish_reason: null }] })}\n\n`);
				} else if (parsed.messages.some((message) => message.role === "tool")) reply(response);
				else reply(response, "bash", { command: "printf 'effect\\n' >> effect.txt; printf started > started.txt; while [ ! -f release.txt ]; do sleep 0.1; done", timeout: 20 });
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			await mkdir(library); await mkdir(userData);
			await writeFile(join(userData, "last-library.json"), JSON.stringify({ rootPath: library }));
			await writeFile(join(userData, "general.json"), JSON.stringify({ language: "en", reopenLastLibrary: true }));
			app = await launchTestElectron(userData);
			let page = await app.firstWindow();
			await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
			const session = (await page.evaluate(() => window.loom.listSessions()))[0]!;
			await saveChatEndpoint(page, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
			await page.evaluate((id) => window.loom.setSessionModel(id, { provider: "e2e-chat", modelId: "demo", thinkingLevel: "off" }), session.id);
			await page.evaluate(async () => {
				await window.loom.setAgentPermission("full");
				await window.loom.saveAgentSandbox(false);
			});
			await page.getByRole("textbox").fill(`Crash during ${boundary}`); await page.getByRole("textbox").press("Enter");
			if (boundary === "streaming") await expect(page.getByText("Unfinished before crash", { exact: true })).toBeVisible();
			else await expect.poll(() => readFile(join(library, "started.txt"), "utf8").catch(() => "")).toBe("started");
			expect(requests).toBe(1);
			await killElectron(app, boundary === "unsafe-bash" ? () => writeFile(join(library, "release.txt"), "release") : undefined); app = undefined;
			app = await launchTestElectron(userData); page = await app.firstWindow();
			await expect(page.getByText("Recovered and saved.", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
			expect(requests).toBe(2);
			expect(modelInputs[1]).toEqual(modelInputs[0]);
			expect((await page.evaluate(() => window.loom.listSessions())).map((row) => row.id)).toEqual([session.id]);
			const record = await page.evaluate((id) => window.loom.getSession(id), session.id);
			expect(record.messages.filter((message) => message.role === "user")).toHaveLength(1);
			if (boundary === "streaming") {
				const assistants = record.messages.filter((message) => message.role === "assistant");
				expect(assistants.map((message) => message.stopReason)).toEqual(["aborted", "stop"]);
				await expect(page.getByText("Unfinished before crash", { exact: true })).toHaveCount(1);
				await expect(page.getByText("Recovered and saved.", { exact: true })).toHaveCount(1);
			} else {
				expect(await readFile(join(library, "effect.txt"), "utf8")).toBe("effect\n");
				const result = record.messages.find((message) => message.role === "toolResult");
				expect(result?.isError).toBe(true);
				expect(JSON.stringify(result?.content)).toMatch(/interrupted.*may have partially run/i);
			}
			await page.reload();
			await expect(page.getByText("Recovered and saved.", { exact: true }).first()).toBeVisible();
			expect(requests).toBe(2);
		} finally {
			// An OS child may outlive SIGKILL. Release it independently; the durable task must not replay it.
			await writeFile(join(library, "release.txt"), "release").catch(() => {});
			await app?.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app?.close().catch(() => {});
			server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	});
}

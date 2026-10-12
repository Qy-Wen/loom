import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { launchTestElectron } from "./loom.ts";

function reply(response: ServerResponse, tool?: string, args = {}) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const delta = tool ? { tool_calls: [{ index: 0, id: `call-${tool}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: "Recovered and saved." };
	response.end(`data: ${JSON.stringify({ id: "recover", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "recover", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
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
		await page.evaluate(async (baseUrl) => {
			const current = await window.loom.getModelSettings();
			await window.loom.saveModelSettings({ ...current, chat: { baseUrl, model: "demo", apiKey: "test", enabled: true } });
			await window.loom.setAgentPermission("basic");
		}, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
		await page.getByRole("textbox").fill("Recover this task"); await page.getByRole("textbox").press("Enter");
		await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
		const childBefore = (await page.getByRole("button", { name: "write waiting", exact: true }).count());
		expect(childBefore).toBe(1);
		await expect.poll(() => parentRequests).toBe(1); expect(childRequests).toBe(1);
		await expect(readFile(join(library, "recovered.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		const child = app.process();
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL"); await exited;
		await app.close().catch(() => {}); app = undefined;
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

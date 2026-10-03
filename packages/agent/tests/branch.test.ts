import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { userTextFromContent } from "../src/attachments.ts";
import { HarnessSessionManager, type HarnessSessionRecord } from "../src/harness-session-manager.ts";

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function stop(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function userTexts(record: HarnessSessionRecord): string[] {
	return record.messages
		.filter((message) => message.role === "user")
		.map((message) => userTextFromContent(message.content));
}

function userId(record: HarnessSessionRecord, text: string): string {
	const message = record.messages.find((entry) => entry.role === "user" && userTextFromContent(entry.content) === text);
	assert.equal(typeof message?.id, "string");
	return message!.id as string;
}

describe("branching from a previous question", () => {
	it("keeps the old path in the tree and forks the prefix without touching library files", async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests += 1;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write('data: {"id":"branch","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n');
			response.write('data: {"id":"branch","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
			response.end("data: [DONE]\n\n");
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-branch-"));
		const manager = new HarnessSessionManager({ chat: { baseUrl, apiKey: "test", model: "demo" } });
		try {
			await writeFile(join(root, "keep.txt"), "leave this file");
			await manager.openLibrary(root);
			const session = await manager.createSession();
			await manager.prompt(session.id, "first question");
			await manager.prompt(session.id, "second question");
			const full = await manager.getSession(session.id);
			assert.deepEqual(userTexts(full), ["first question", "second question"]);

			const secondId = userId(full, "second question");
			const forked = await manager.forkBefore(session.id, secondId);
			assert.notEqual(forked.id, session.id);
			assert.equal(forked.title, "Fork: New session");
			assert.equal((await manager.getSession(session.id)).title, "New session");
			assert.deepEqual(userTexts(forked), ["first question"]);
			assert.deepEqual(userTexts(await manager.getSession(session.id)), ["first question", "second question"]);

			const branched = await manager.branchBefore(session.id, secondId);
			assert.deepEqual(userTexts(branched), ["first question"]);
			assert.equal(requests, 2);
			const sessionsRoot = join(root, ".loom", "harness-sessions");
			const directories = await readdir(sessionsRoot);
			const files = await Promise.all(directories.map(async (directory) => {
				const [file] = await readdir(join(sessionsRoot, directory));
				return readFile(join(sessionsRoot, directory, file!), "utf8");
			}));
			assert.equal(files.some((text) => text.includes("second question")), true);
			assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "leave this file");
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
			await stop(server);
		}
	});
});

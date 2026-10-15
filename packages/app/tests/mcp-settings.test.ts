import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { draftToRawServer, emptyMcpServerDraft, parseEnvText } from "../src/shared/mcp-settings.ts";
import { configToDraft, draftsToFile, McpSettingsStore } from "../src/main/mcp/store.ts";

describe("mcp drafts", () => {
	it("round-trips a stdio server and env lines", () => {
		const draft = {
			...emptyMcpServerDraft(),
			id: "demo",
			command: "npx",
			argsText: "-y\nmcp-demo",
			envText: "TOKEN=secret\nHOME=/tmp",
		};
		assert.deepEqual(draftToRawServer(draft), {
			id: "demo",
			command: "npx",
			enabled: false,
			args: ["-y", "mcp-demo"],
			env: { TOKEN: "secret", HOME: "/tmp" },
		});
		assert.deepEqual(parseEnvText("A=1\nB=two=2"), { A: "1", B: "two=2" });
		assert.equal(configToDraft({
			id: "demo",
			command: "npx",
			args: ["-y"],
			env: { TOKEN: "secret" },
			enabled: true,
		}).envText, "TOKEN=secret");
	});
});

describe("McpSettingsStore", () => {
	it("starts empty, then overwrites on save", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-mcp-settings-"));
		const dest = join(dir, "mcp.json");
		const store = new McpSettingsStore(dest);
		assert.deepEqual(await store.load(), []);
		await store.save([{
			...emptyMcpServerDraft(),
			id: "cloud",
			transport: "http",
			url: "https://example.com/mcp",
		}]);
		const saved = JSON.parse(await readFile(dest, "utf8")) as { servers: Array<{ id: string }> };
		assert.deepEqual(saved.servers.map((row) => row.id), ["cloud"]);
		assert.deepEqual(draftsToFile([]), { servers: [] });
	});

	it("drops obsolete agent routing when saving existing servers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-mcp-settings-"));
		const path = join(dir, "mcp.json");
		const store = new McpSettingsStore(path);
		await writeFile(path, JSON.stringify({ servers: [
			{ id: "publish", command: "node", agent: "main" },
			{ id: "comfy", url: "http://localhost/mcp", agent: "create" },
		] }));
		const drafts = await store.drafts();
		assert.equal(drafts[0]?.command, "node");
		assert.equal(drafts[1]?.url, "http://localhost/mcp");
		await store.save(drafts);
		const saved = JSON.parse(await readFile(path, "utf8")) as { servers: Record<string, unknown>[] };
		assert.ok(saved.servers.every((server) => !("agent" in server)));
	});

	it("rejects a server with no id or command", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-mcp-settings-"));
		const store = new McpSettingsStore(join(dir, "mcp.json"));
		await assert.rejects(
			() => store.save([{ ...emptyMcpServerDraft(), command: "echo" }]),
			/needs an id/,
		);
	});
});

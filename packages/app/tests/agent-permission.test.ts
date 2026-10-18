import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_AGENT_PERMISSION } from "@loom/agent";
import { AgentPermissionStore } from "../src/main/settings/agent-permission-store.ts";

describe("AgentPermissionStore", () => {
	it("defaults to standard and persists the chosen level", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-agent-permission-"));
		const missing = new AgentPermissionStore(join(dir, "missing.json"));
		assert.equal(await missing.load(), DEFAULT_AGENT_PERMISSION);

		const store = new AgentPermissionStore(join(dir, "agent-permission.json"));
		assert.equal(await store.save("full"), "full");
		assert.equal(await store.load(), "full");

		const again = new AgentPermissionStore(join(dir, "agent-permission.json"));
		assert.equal(await again.load(), "full");
	});

	it("falls back to standard for unknown stored values", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-agent-permission-"));
		const filePath = join(dir, "agent-permission.json");
		await writeFile(filePath, `${JSON.stringify({ level: "nope" }, null, "\t")}\n`, "utf8");
		const store = new AgentPermissionStore(filePath);
		assert.equal(await store.load(), DEFAULT_AGENT_PERMISSION);
		await store.save("basic");
		assert.match(await readFile(filePath, "utf8"), /"level": "basic"/);
	});
});

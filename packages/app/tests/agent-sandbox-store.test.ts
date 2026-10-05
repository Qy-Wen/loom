import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSandboxStore } from "../src/main/agent-sandbox-store.ts";
import { processSandboxActive } from "../src/shared/agent-sandbox.ts";

test("AgentSandboxStore defaults on and round-trips the switch", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-agent-sandbox-"));
	const file = join(root, "agent-sandbox.json");
	try {
		const store = new AgentSandboxStore(file);
		assert.equal(await store.load(), true);
		assert.equal(await store.save(false), false);
		assert.equal(await readFile(file, "utf8"), `${JSON.stringify({ enabled: false }, null, "\t")}\n`);
		assert.equal(await new AgentSandboxStore(file).load(), false);

		await writeFile(file, "{}\n", "utf8");
		assert.equal(await new AgentSandboxStore(file).load(), true);
		assert.equal(processSandboxActive(true, "standard"), true);
		assert.equal(processSandboxActive(true, "full"), false);
		assert.equal(processSandboxActive(false, "basic"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

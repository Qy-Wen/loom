import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentInstructionsStore } from "../src/main/settings/agent-instructions-store.ts";
import { INSTRUCTIONS_CHAR_LIMIT } from "../src/shared/agent-instructions.ts";

test("AgentInstructionsStore round-trips text and refuses an overflow", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-agents-"));
	const file = join(root, "AGENTS.md");
	const store = new AgentInstructionsStore(file);
	try {
		assert.equal(await store.load(), "");
		assert.equal(await store.save("Prefer short titles.\r\n"), "Prefer short titles.\n");
		assert.equal(await readFile(file, "utf8"), "Prefer short titles.\n");
		assert.equal(await store.load(), "Prefer short titles.\n");
		await assert.rejects(
			() => store.save("x".repeat(INSTRUCTIONS_CHAR_LIMIT + 1)),
			/Shorten them/,
		);
		assert.equal(await store.load(), "Prefer short titles.\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

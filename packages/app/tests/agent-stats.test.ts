import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cacheHitRate } from "../src/shared/agent-stats.ts";
import { AgentStatsStore } from "../src/main/chat/agent-stats-store.ts";

describe("cacheHitRate", () => {
	it("is cacheRead over the prompt token sum", () => {
		assert.equal(cacheHitRate({ input: 177, cacheRead: 768, cacheWrite: 0 }), 768 / 945);
		assert.equal(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), 0);
	});
});

describe("AgentStatsStore", () => {
	it("persists recorded usage and can reset", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-stats-"));
		const store = new AgentStatsStore(join(dir, "agent-stats.json"));
		await store.record({ input: 100, output: 8, cacheRead: 900, cacheWrite: 0 });
		const view = await store.view();
		assert.equal(view.turns, 1);
		assert.equal(view.cacheRead, 900);
		assert.ok(view.cacheHit > 0.8);
		const raw = JSON.parse(await readFile(join(dir, "agent-stats.json"), "utf8")) as { turns: number };
		assert.equal(raw.turns, 1);
		const cleared = await store.reset();
		assert.equal(cleared.turns, 0);
		assert.equal(cleared.cacheHit, 0);
	});
});

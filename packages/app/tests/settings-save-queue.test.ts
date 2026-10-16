import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsSaveQueue } from "../src/renderer/settings/settings-save-queue.ts";

test("automatic settings saves run in order and flush waits for committed writes", async () => {
	const queue = new SettingsSaveQueue();
	const release = Promise.withResolvers<void>();
	const events: string[] = [];
	const first = queue.run(async () => { events.push("first:start"); await release.promise; events.push("first:end"); return 1; });
	const second = queue.run(async () => { events.push("second"); return 2; });
	let flushed = false;
	const flush = queue.flush().then(() => { flushed = true; });
	await Promise.resolve();
	assert.deepEqual(events, ["first:start"]); assert.equal(flushed, false);
	release.resolve();
	assert.equal(await first, 1); assert.equal(await second, 2); await flush;
	assert.deepEqual(events, ["first:start", "first:end", "second"]); assert.equal(flushed, true);
});

test("one failed write does not poison subsequent automatic saves", async () => {
	const queue = new SettingsSaveQueue();
	await assert.rejects(queue.run(async () => { throw new Error("write failed"); }), /write failed/);
	assert.equal(await queue.run(async () => "saved"), "saved");
	await queue.flush();
});

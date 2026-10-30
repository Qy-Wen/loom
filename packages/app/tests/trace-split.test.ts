import assert from "node:assert/strict";
import { test } from "node:test";
import { readSplitSize, splitBounds, splitSize, TRACE_SPLIT_HANDLE } from "../src/renderer/dev-trace/split-size.ts";

test("trace dividers clamp both panes without overrunning the available space", () => {
	const available = 980 - TRACE_SPLIT_HANDLE;
	assert.deepEqual(splitBounds(available, 180, 320), { min: 180, max: 654 });
	assert.equal(splitSize(280, available, 180, 320), 280);
	assert.equal(splitSize(-100, available, 180, 320), 180);
	assert.equal(splitSize(2000, available, 180, 320), 654);
	assert.equal(splitSize(0.5 * available, available, 180, 320), 487);
});

test("trace pane minima yield proportionally in very small or hidden windows", () => {
	assert.deepEqual(splitBounds(250, 180, 320), { min: 90, max: 90 });
	assert.equal(splitSize(280, 250, 180, 320), 90);
	assert.equal(splitSize(280, 0, 180, 320), 0);
	assert.equal(splitSize(280, -1, 180, 320), 0);
	assert.equal(splitSize(280, 500, 0, 0), 280);
});

test("trace layout preferences reject corrupt values and tolerate unavailable storage", () => {
	for (const value of [null, "not a number", "Infinity", "-1"]) {
		assert.equal(readSplitSize({ getItem: () => value }, "width", 280), 280);
	}
	assert.equal(readSplitSize({ getItem: () => "360" }, "width", 280), 360);
	assert.equal(readSplitSize({ getItem: () => "0.65" }, "fraction", 0.5), 0.65);
	assert.equal(readSplitSize({ getItem: () => { throw new Error("unavailable"); } }, "width", 280), 280);
});

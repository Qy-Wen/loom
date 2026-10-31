import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SHORTCUT_FRACTION, libraryRegionSize } from "../src/renderer/library/library-region-size.ts";

test("shortcut content defaults to a 40% cap, leaving the rest for the file tree", () => {
	assert.deepEqual(libraryRegionSize(406, 1000, DEFAULT_SHORTCUT_FRACTION), { size: 160, min: 64, max: 280, extent: 400 });
});

test("small or folded shortcut groups return their unused space without changing the preference", () => {
	assert.equal(libraryRegionSize(606, 32, 0.7).size, 32);
	assert.equal(libraryRegionSize(606, 500, 0.7).size, 420);
	assert.equal(libraryRegionSize(606, 0, 0.4).size, 0);
});

test("dragged region sizes retain usable minima for both panes", () => {
	assert.equal(libraryRegionSize(406, 1000, 0).size, 64);
	assert.equal(libraryRegionSize(406, 1000, 1).size, 280);
	assert.equal(libraryRegionSize(406, 120, 1).size, 120);
});

test("minima yield proportionally in short or hidden layouts without negative sizes", () => {
	for (const height of [0, 4, 6, 20, 100, 184]) {
		const { size, min, max, extent } = libraryRegionSize(height, 1000, 0.4);
		assert.ok(min >= 0 && size >= min && size <= max && max <= extent);
		if (extent > 0) assert.ok(Math.abs(size / extent - 64 / 184) < 1e-10);
	}
});

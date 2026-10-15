import assert from "node:assert/strict";
import { test } from "node:test";
import { clampColumn } from "../src/renderer/layout/use-resizable-layout.ts";

test("a column grows until the workbench reserve, and shrinks only to its minimum", () => {
	assert.equal(clampColumn(800, 900, 180), 800);
	assert.equal(clampColumn(1200, 900, 180), 900);
	assert.equal(clampColumn(40, 900, 180), 180);
	assert.equal(clampColumn(400, 120, 180), 120);
});

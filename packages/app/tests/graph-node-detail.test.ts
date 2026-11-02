import assert from "node:assert/strict";
import { test } from "node:test";
import { graphNodeDetail } from "../src/renderer/workbench/graph/graph-layout.ts";

test("a node is drawn in full until it is too small on screen to read, then as a dot", () => {
	assert.equal(graphNodeDetail(1), "full");
	assert.equal(graphNodeDetail(0.5), "full");
	assert.equal(graphNodeDetail(0.25), "full");
	assert.equal(graphNodeDetail(0.2), "dot");
	assert.equal(graphNodeDetail(0.15), "dot");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { graphBounds, layoutForceGraph } from "../src/renderer/graph-layout.ts";

test("layoutForceGraph keeps every id and separates a linked pair", () => {
	const nodes = layoutForceGraph(
		["out", "src", "lonely"],
		[{ fromId: "out", toId: "src" }],
	);
	assert.deepEqual(nodes.map((node) => node.id).sort(), ["lonely", "out", "src"]);
	const out = nodes.find((node) => node.id === "out");
	const src = nodes.find((node) => node.id === "src");
	assert.ok(out && src);
	assert.equal(out.x === src.x && out.y === src.y, false);
});

test("graphBounds pads a single node", () => {
	const bounds = graphBounds([{ id: "a", x: 0, y: 0 }], 10);
	assert.equal(bounds.minX, -10);
	assert.equal(bounds.minY, -10);
	assert.equal(bounds.width, 20);
	assert.equal(bounds.height, 20);
});

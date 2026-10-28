import assert from "node:assert/strict";
import { test } from "node:test";
import { graphBounds, layoutForceGraph, nearestNode, nodeHitZone, nodesInRect, rectBetween } from "../src/renderer/workbench/graph-layout.ts";

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

test("nodeHitZone splits the disc into body and rim", () => {
	assert.equal(nodeHitZone(0, 14), "body");
	assert.equal(nodeHitZone(8, 14), "body");
	assert.equal(nodeHitZone(14, 14), "rim");
	assert.equal(nodeHitZone(24, 14), "rim");
	assert.equal(nodeHitZone(40, 14), "none");
});

test("nearestNode snaps within the pad and skips the source", () => {
	const nodes = [
		{ id: "a", x: 0, y: 0 },
		{ id: "b", x: 20, y: 0 },
	];
	assert.equal(nearestNode(nodes, 18, 0, "a", 30)?.id, "b");
	assert.equal(nearestNode(nodes, 18, 0, null, 30)?.id, "b");
	assert.equal(nearestNode(nodes, 200, 0, "a", 30), undefined);
});

test("graphBounds pads a single node", () => {
	const bounds = graphBounds([{ id: "a", x: 0, y: 0 }], 10);
	assert.equal(bounds.minX, -10);
	assert.equal(bounds.minY, -10);
	assert.equal(bounds.width, 20);
	assert.equal(bounds.height, 20);
});

test("rectBetween gives the same box whichever corner the drag started from", () => {
	const expected = { minX: 10, minY: 20, maxX: 50, maxY: 80 };
	assert.deepEqual(rectBetween({ x: 10, y: 20 }, { x: 50, y: 80 }), expected);
	assert.deepEqual(rectBetween({ x: 50, y: 80 }, { x: 10, y: 20 }), expected);
	assert.deepEqual(rectBetween({ x: 50, y: 20 }, { x: 10, y: 80 }), expected);
});

test("nodesInRect takes the nodes whose centre is inside, edges included", () => {
	const nodes = [
		{ id: "in", x: 30, y: 30 },
		{ id: "edge", x: 50, y: 80 },
		{ id: "outside", x: 51, y: 30 },
		{ id: "above", x: 30, y: 19 },
	];
	const rect = rectBetween({ x: 10, y: 20 }, { x: 50, y: 80 });
	assert.deepEqual(nodesInRect(nodes, rect), ["in", "edge"]);
	assert.deepEqual(nodesInRect(nodes, rectBetween({ x: 0, y: 0 }, { x: 1, y: 1 })), []);
	assert.deepEqual(nodesInRect([], rect), []);
});

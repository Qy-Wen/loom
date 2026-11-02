import assert from "node:assert/strict";
import { test } from "node:test";
import { FR_MAX_NODES, graphBounds, layoutForceGraph, nearestNode, nodeHitZone, nodesInRect, rectBetween, rectContains, segmentMayCross, viewWorldRect } from "../src/renderer/workbench/graph/graph-layout.ts";

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

test("nodeHitZone reveals the link handle only outside the disc and outline", () => {
	assert.equal(nodeHitZone(0, 14), "body");
	assert.equal(nodeHitZone(8, 14), "body");
	assert.equal(nodeHitZone(13.9, 14), "body");
	assert.equal(nodeHitZone(14, 14), "body");
	assert.equal(nodeHitZone(15, 14), "body");
	assert.equal(nodeHitZone(15.1, 14), "rim");
	assert.equal(nodeHitZone(24, 14), "rim");
	assert.equal(nodeHitZone(30, 14), "rim");
	assert.equal(nodeHitZone(30.1, 14), "none");
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

test("viewWorldRect maps the canvas and a pixel margin back to world coordinates", () => {
	const rect = viewWorldRect({ x: 100, y: 50, scale: 2 }, { width: 400, height: 200 }, 20);
	assert.deepEqual(rect, { minX: -60, minY: -35, maxX: 160, maxY: 85 });
	assert.equal(rectContains(rect, 0, 0), true);
	assert.equal(rectContains(rect, 161, 0), false);
	assert.equal(rectContains(rect, 160, 85), true);
});

test("segmentMayCross keeps a line that spans the view and drops one entirely outside", () => {
	const rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
	assert.equal(segmentMayCross(rect, -500, 50, 500, 50), true);
	assert.equal(segmentMayCross(rect, 20, 20, 30, 30), true);
	assert.equal(segmentMayCross(rect, 150, 0, 300, 100), false);
	assert.equal(segmentMayCross(rect, 0, -50, 100, -10), false);
});

test("layoutForceGraph skips the quadratic pass for a large graph but still places every node once", () => {
	const ids = Array.from({ length: FR_MAX_NODES + 50 }, (_, i) => `n${i}`);
	const started = performance.now();
	const nodes = layoutForceGraph(ids, [{ fromId: "n0", toId: "n1" }]);
	assert.ok(performance.now() - started < 200);
	assert.equal(new Set(nodes.map((node) => node.id)).size, ids.length);
	assert.equal(new Set(nodes.map((node) => `${node.x.toFixed(3)},${node.y.toFixed(3)}`)).size, ids.length);
});

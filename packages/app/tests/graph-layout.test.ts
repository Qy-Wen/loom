import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssetRelation } from "@loom/core";
import { GRAPH_ARROW_REF_X, GRAPH_ARROW_SIZE, indexParallelEdges, routeGraphEdge } from "../src/renderer/workbench/graph/graph-edge-layout.ts";
import { FR_MAX_NODES, GRAPH_NODE_OUTER_RADIUS, graphBounds, layoutForceGraph, nearestNode, nodeHitZone, nodesInRect, rectBetween, rectContains, segmentMayCross, uniqueLayoutEdges, viewWorldRect } from "../src/renderer/workbench/graph/graph-layout.ts";

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

test("layout combines parallel and reciprocal relations into one spring per pair", () => {
	const edges = [
		{ fromId: "b", toId: "c" },
		{ fromId: "b", toId: "a" },
		{ fromId: "a", toId: "b" },
		{ fromId: "b", toId: "a" },
		{ fromId: "a", toId: "a" },
	];
	const expected = [{ fromId: "a", toId: "b" }, { fromId: "b", toId: "c" }];
	assert.deepEqual(uniqueLayoutEdges(edges), expected);
	assert.deepEqual(uniqueLayoutEdges([...edges].reverse()), expected);
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

test("parallel edges use separate radial endpoints and spread symmetrically with mixed directions", () => {
	const nodes = { a: { x: 0, y: 0 }, b: { x: 120, y: 0 } };
	const edges: AssetRelation[] = Array.from({ length: 32 }, (_, index) => ({
		relationId: String(index),
		fromAssetId: index % 2 ? "b" : "a",
		toAssetId: index % 2 ? "a" : "b",
		type: String(index),
		source: "manual",
	}));
	for (const count of [2, 3, 8, 32]) {
		const group = edges.slice(0, count);
		const lanes = indexParallelEdges(group);
		assert.deepEqual(lanes, indexParallelEdges([...group].reverse()));
		const routes = group.map((edge) => {
			const forward = edge.fromAssetId === "a";
			const from = forward ? nodes.a : nodes.b;
			const to = forward ? nodes.b : nodes.a;
			const route = routeGraphEdge(from, to, lanes.get(edge.relationId))!;
			const coordinates = route.path.split(" ").map(Number).filter(Number.isFinite);
			const [startX, startY] = coordinates;
			const [endX, endY] = coordinates.slice(-2);
			const startGap = Math.hypot(startX! - from.x, startY!) - GRAPH_NODE_OUTER_RADIUS;
			const arrowTipGap = Math.hypot(endX! - to.x, endY!) - (GRAPH_ARROW_SIZE - GRAPH_ARROW_REF_X) - GRAPH_NODE_OUTER_RADIUS;
			assert.ok(Math.abs(startGap - 4.25) < 1e-8);
			assert.ok(Math.abs(arrowTipGap - 2.5) < 1e-8);
			return { route, startY, endY };
		});
		assert.equal(new Set(routes.map(({ startY }) => startY)).size, count);
		assert.equal(new Set(routes.map(({ endY }) => endY)).size, count);
		const midpoints = routes.map(({ route }) => route.labelY).sort((a, b) => a - b);
		assert.deepEqual(midpoints, Array.from({ length: count }, (_, index) => (index - (count - 1) / 2) * 16));
		assert.equal(routes.filter(({ route }) => route.path.includes(" L ")).length, count % 2);
	}
});

test("routing culls by the curve's spread and keeps single edges straight", () => {
	const a = { x: 0, y: 0 }, b = { x: 120, y: 0 };
	const viewport = { minX: 0, minY: 6, maxX: 120, maxY: 20 };
	assert.equal(routeGraphEdge(a, b)?.path, "M 14 0 L 99 0");
	assert.equal(routeGraphEdge(a, b, undefined, viewport), null);
	assert.ok(routeGraphEdge(a, b, { slot: 0.5, halfSpan: 0.5 }, viewport)?.path.includes(" C "));
	const outerViewport = { minX: 48, minY: 50, maxX: 72, maxY: 60 };
	assert.ok(routeGraphEdge(a, b, { slot: 3.5, halfSpan: 3.5 }, outerViewport));
	assert.equal(routeGraphEdge(a, b, { slot: 2.5, halfSpan: 3.5 }, outerViewport), null);
	assert.equal(routeGraphEdge(a, a), null);
});

test("layoutForceGraph skips the quadratic pass for a large graph but still places every node once", () => {
	const ids = Array.from({ length: FR_MAX_NODES + 50 }, (_, i) => `n${i}`);
	const started = performance.now();
	const nodes = layoutForceGraph(ids, [{ fromId: "n0", toId: "n1" }]);
	assert.ok(performance.now() - started < 200);
	assert.equal(new Set(nodes.map((node) => node.id)).size, ids.length);
	assert.equal(new Set(nodes.map((node) => `${node.x.toFixed(3)},${node.y.toFixed(3)}`)).size, ids.length);
});

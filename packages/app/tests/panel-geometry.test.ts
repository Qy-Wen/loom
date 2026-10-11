import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { joinGroup, joinMembers, mergeTabOrder, placeTab, tabAfterDetach } from "../src/renderer/layout/use-panel-layout.ts";
import { bottomBand, clampFloat, pointerDocks, pointerInside, pointerNearLowerBand, pointerOnLeftEdge, pointerOnTopEdge } from "../src/renderer/layout/panel-geometry.ts";

describe("panel geometry", () => {
	it("keeps a floating window inside the shell", () => {
		assert.deepEqual(
			clampFloat({ x: -20, y: 900, width: 800, height: 100 }, { width: 1000, height: 700 }),
			{ x: 0, y: 500, width: 800, height: 200 },
		);
	});

	it("joins the lower band to both sidebars", () => {
		const band = bottomBand({ width: 1200, height: 800 }, 240, 380, 360);
		assert.equal(band.x, 245);
		assert.equal(band.width, 570);
		assert.equal(band.y, 435);
		assert.equal(band.height, 365);
		assert.equal(band.x + band.width, 1200 - 380 - 5);
		assert.equal(pointerNearLowerBand(band.x + 20, band.y + 20, band), true);
		assert.equal(pointerNearLowerBand(band.x + 20, band.y - 40, band), true);
		assert.equal(pointerNearLowerBand(band.x + 20, band.y - 80, band), false);
		assert.equal(pointerNearLowerBand(band.x + band.width + 10, band.y + 20, band), false);
	});

	it("hits a panel only inside its box", () => {
		const box = { left: 100, top: 40, right: 400, bottom: 500 };
		assert.equal(pointerInside(120, 80, box), true);
		assert.equal(pointerInside(99, 80, box), false);
		assert.equal(pointerInside(120, 520, box), false);
	});

	it("places a dragged tab when the pointer crosses another tab", () => {
		const pair = ["agent", "details"] as const;
		const pairBoxes = [{ left: 40, right: 60 }, { left: 60, right: 100 }];
		assert.deepEqual(placeTab(pair, "agent", 90, pairBoxes), ["details", "agent"]);
		assert.deepEqual(placeTab(pair, "agent", 70, pairBoxes), ["agent", "details"]);
		assert.deepEqual(placeTab(pair, "details", 40, pairBoxes), ["details", "agent"]);
		assert.deepEqual(placeTab(pair, "details", 60, pairBoxes), ["agent", "details"]);

		const three = ["agent", "details", "grade"] as const;
		const boxes = [
			{ left: 0, right: 40 },
			{ left: 40, right: 80 },
			{ left: 80, right: 120 },
		];
		assert.deepEqual(placeTab(three, "agent", 70, boxes), ["details", "agent", "grade"]);
		assert.deepEqual(placeTab(three, "agent", 50, boxes), ["agent", "details", "grade"]);
		assert.deepEqual(placeTab(three, "agent", 110, boxes), ["details", "grade", "agent"]);
		assert.deepEqual(placeTab(three, "grade", 10, boxes), ["grade", "agent", "details"]);
		assert.deepEqual(
			mergeTabOrder(["agent", "grade", "details"], ["agent", "details"], ["details", "agent"]),
			["details", "grade", "agent"],
		);
	});

	it("selects a remaining tab after the active one is pulled out", () => {
		const members = ["agent", "details", "grade"] as const;
		assert.equal(tabAfterDetach("agent", members, "agent", true), "details");
		assert.equal(tabAfterDetach("details", members, "agent", true), "details");
		assert.equal(tabAfterDetach("grade", members, "grade", true), "agent");
		assert.equal(tabAfterDetach("agent", ["agent", "grade"], "agent", false), "agent");
	});

	it("adds the dropped panel to the target's tab group", () => {
		assert.deepEqual(joinMembers([], "grade", "details"), ["details", "grade"]);
		assert.deepEqual(joinMembers(["agent", "details"], "grade", "details"), ["agent", "details", "grade"]);
		assert.deepEqual(joinMembers(["details", "grade"], "grade", "agent"), ["agent", "grade"]);
		assert.deepEqual(joinMembers(["details", "grade"], "agent", "grade"), ["details", "grade", "agent"]);
	});

	it("keeps every tab when a group is dropped onto another panel", () => {
		assert.deepEqual(joinGroup(["agent", "details"], "grade"), ["grade", "agent", "details"]);
		assert.deepEqual(joinGroup(["agent", "details"], "details"), ["agent", "details"]);
	});

	it("splices to the left of a right panel and above a lower panel", () => {
		const right = { left: 900, top: 0, right: 1200, bottom: 800 };
		const lower = { left: 240, top: 600, right: 890, bottom: 800 };
		assert.equal(pointerOnLeftEdge(880, 200, right), true);
		assert.equal(pointerOnLeftEdge(940, 200, right), true);
		assert.equal(pointerOnLeftEdge(1100, 200, right), false);
		assert.equal(pointerOnTopEdge(400, 570, lower), true);
		assert.equal(pointerOnTopEdge(400, 630, lower), true);
		assert.equal(pointerOnTopEdge(400, 720, lower), false);
	});

	it("docks only when the pointer is on the right edge", () => {
		assert.equal(pointerDocks(980, 1000), true);
		assert.equal(pointerDocks(900, 1000), false);
	});
});

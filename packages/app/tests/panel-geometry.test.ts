import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextTabOrder } from "../src/renderer/layout/use-panel-layout.ts";
import { bottomBand, clampFloat, pointerDocks, pointerInside, pointerNearLowerBand } from "../src/renderer/layout/panel-geometry.ts";

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

	it("swaps tab order when the pointer crosses the other tab", () => {
		const agentFirst = ["agent", "details"] as const;
		assert.deepEqual(nextTabOrder(agentFirst, "agent", 90, 80), ["details", "agent"]);
		assert.deepEqual(nextTabOrder(agentFirst, "agent", 70, 80), ["agent", "details"]);
		assert.deepEqual(nextTabOrder(agentFirst, "details", 40, 50), ["details", "agent"]);
		assert.deepEqual(nextTabOrder(agentFirst, "details", 60, 50), ["agent", "details"]);
	});

	it("docks only when the pointer is on the right edge", () => {
		assert.equal(pointerDocks(980, 1000), true);
		assert.equal(pointerDocks(900, 1000), false);
	});
});

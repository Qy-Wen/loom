import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FIT_MEDIA_VIEW,
	clampMediaPan,
	fittedMediaSize,
	maxMediaScale,
	mediaLayerTransform,
	panMedia,
	toggleMediaZoom,
	wheelZoomFactor,
	zoomMediaAt,
} from "../src/renderer/workbench/media-zoom.ts";

function close(actual: number, expected: number, epsilon = 0.001): void {
	assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} !== ${expected}`);
}

describe("media zoom", () => {
	it("fits large media and leaves small media at its natural size", () => {
		assert.deepEqual(fittedMediaSize({ width: 4000, height: 1000 }, { width: 200, height: 200 }), { width: 200, height: 50 });
		assert.deepEqual(fittedMediaSize({ width: 100, height: 100 }, { width: 400, height: 300 }), { width: 100, height: 100 });
		assert.deepEqual(fittedMediaSize({ width: 0, height: 10 }, { width: 100, height: 100 }), { width: 0, height: 0 });
	});

	it("allows native-pixel zoom without passing the cap", () => {
		assert.equal(maxMediaScale({ width: 100, height: 100 }, { width: 100, height: 100 }), 16);
		assert.equal(maxMediaScale({ width: 8000, height: 4000 }, { width: 200, height: 100 }), 32);
	});

	it("keeps the cursor point fixed when the picture sticks out of the frame", () => {
		const next = zoomMediaAt(FIT_MEDIA_VIEW, { x: 80, y: 40 }, 2, { width: 400, height: 300 }, { width: 300, height: 300 });
		close(next.scale, 2);
		close(next.x, -80);
		close(next.y, -40);
		close(80 * next.scale + next.x, 80);
		close(40 * next.scale + next.y, 40);
	});

	it("stays centered when the zoomed picture still fits", () => {
		const next = zoomMediaAt(FIT_MEDIA_VIEW, { x: 50, y: 20 }, 2, { width: 400, height: 300 }, { width: 100, height: 100 });
		close(next.scale, 2);
		close(next.x, 0);
		close(next.y, 0);
	});

	it("stops a drag at the edge of the picture", () => {
		const next = panMedia(
			{ scale: 4, x: 0, y: 0 },
			{ x: 1000, y: 1000 },
			{ width: 400, height: 200 },
			{ width: 100, height: 100 },
		);
		close(next.x, 0);
		close(next.y, 100);
	});

	it("does not slide a picture that already fits", () => {
		const next = clampMediaPan(
			{ scale: 1, x: 1000, y: 1000 },
			{ width: 400, height: 300 },
			{ width: 100, height: 100 },
		);
		close(next.x, 0);
		close(next.y, 0);
	});

	it("limits how far the wheel can zoom", () => {
		const shrunk = zoomMediaAt(FIT_MEDIA_VIEW, { x: 0, y: 0 }, 0.01, { width: 400, height: 300 }, { width: 100, height: 100 });
		close(shrunk.scale, 0.25);
		const grown = zoomMediaAt(FIT_MEDIA_VIEW, { x: 0, y: 0 }, 100, { width: 400, height: 300 }, { width: 100, height: 100 });
		close(grown.scale, 16);
	});

	it("treats wheel-up as zoom in", () => {
		assert.ok(wheelZoomFactor(-100) > 1);
		assert.ok(wheelZoomFactor(100) < 1);
		assert.equal(wheelZoomFactor(0), 1);
		assert.ok(wheelZoomFactor(-3, 1) > wheelZoomFactor(-3, 0));
	});

	it("toggles between the fitted view and a 2× zoom", () => {
		const zoomed = toggleMediaZoom(FIT_MEDIA_VIEW, { x: 0, y: 0 }, { width: 400, height: 300 }, { width: 200, height: 150 });
		close(zoomed.scale, 2);
		assert.deepEqual(
			toggleMediaZoom(zoomed, { x: 0, y: 0 }, { width: 400, height: 300 }, { width: 200, height: 150 }),
			FIT_MEDIA_VIEW,
		);
	});

	it("pans in screen pixels and scales around the center", () => {
		assert.equal(mediaLayerTransform({ scale: 2, x: -12, y: 4 }), "translate(-12px, 4px) scale(2)");
	});
});

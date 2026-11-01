import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_ICON_SIZE, normalizeBrowserIconSize } from "../src/renderer/workbench/use-browser-icon-size.ts";

test("browser icon sizes retain the existing default and snap to slider steps", () => {
	assert.equal(BROWSER_ICON_SIZE.default, 112);
	assert.equal(normalizeBrowserIconSize(112), 112);
	assert.equal(normalizeBrowserIconSize(119), 112);
	assert.equal(normalizeBrowserIconSize(121), 128);
	for (let value = BROWSER_ICON_SIZE.min; value <= BROWSER_ICON_SIZE.max; value += BROWSER_ICON_SIZE.step) {
		assert.equal(normalizeBrowserIconSize(value), value);
	}
});

test("browser icon sizes clamp bounds and reject non-finite preferences", () => {
	assert.equal(normalizeBrowserIconSize(-100), BROWSER_ICON_SIZE.min);
	assert.equal(normalizeBrowserIconSize(1000), BROWSER_ICON_SIZE.max);
	for (const value of [NaN, Infinity, -Infinity]) {
		assert.equal(normalizeBrowserIconSize(value), BROWSER_ICON_SIZE.default);
	}
});

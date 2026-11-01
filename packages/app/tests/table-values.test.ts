import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comparePropertyValues, displayPropertyValue } from "../src/renderer/workbench/table/table-values.ts";

describe("table property values", () => {
	it("sorts numbers and booleans by their real types", () => {
		assert.ok(comparePropertyValues(2, 10) < 0);
		assert.ok(comparePropertyValues(false, true) < 0);
		assert.ok(comparePropertyValues("item 2", "item 10") < 0);
	});

	it("formats missing and boolean values", () => {
		assert.equal(displayPropertyValue(undefined, "text"), "—");
		assert.equal(displayPropertyValue(true, "boolean"), "Yes");
		assert.equal(displayPropertyValue(false, "boolean"), "No");
		assert.equal(displayPropertyValue(4.5, "number"), "4.5");
	});
});

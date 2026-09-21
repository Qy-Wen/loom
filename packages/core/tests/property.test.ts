import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPropertyDefinition, assertPropertyValue } from "../src/model/property.ts";

describe("property validation", () => {
	it("rejects empty names and unsupported definition types", () => {
		assert.throws(
			() => assertPropertyDefinition({ propertyId: "p", name: "  ", type: "text", createdAt: 1 }),
			/name cannot be empty/,
		);
		assert.throws(
			() => assertPropertyDefinition({ propertyId: "p", name: "Status", type: "select" as never, createdAt: 1 }),
			/Invalid property type/,
		);
	});

	it("accepts values matching each property type", () => {
		assert.doesNotThrow(() => assertPropertyValue("text", "ready"));
		assert.doesNotThrow(() => assertPropertyValue("number", 4.5));
		assert.doesNotThrow(() => assertPropertyValue("boolean", false));
		assert.doesNotThrow(() => assertPropertyValue("date", "2026-09-21"));
	});

	it("rejects mismatched, non-finite, and invalid calendar values", () => {
		assert.throws(() => assertPropertyValue("number", "4"), /Invalid number/);
		assert.throws(() => assertPropertyValue("number", Number.NaN), /Invalid number/);
		assert.throws(() => assertPropertyValue("date", "2026-02-30"), /Invalid date/);
		assert.throws(() => assertPropertyValue("date", "09/21/2026"), /Invalid date/);
	});
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { traceBlobMark } from "@loom/agent/trace-blob";
import { jsonEntries, jsonPath, jsonString, parseTraceJson } from "../src/renderer/dev-trace/json-values.ts";

const HASH = "0123456789abcdef";

test("JSON payload parsing distinguishes all valid roots from legacy text", () => {
	for (const value of [null, false, 0, "plain", [], {}, { text: "{not nested JSON}" }]) {
		assert.deepEqual(parseTraceJson(JSON.stringify(value)), { kind: "json", value });
	}
	for (const text of ["", "plain text", '{"field": "partial', "[1,\n… (bytes cut)"]) {
		assert.deepEqual(parseTraceJson(text), { kind: "text" });
	}
});

test("JSON node identity is stable and unambiguous for unusual keys and array indices", () => {
	assert.equal(jsonPath("", "a/b~c"), "/a~1b~0c");
	assert.notEqual(jsonPath("", "a/b"), jsonPath(jsonPath("", "a"), "b"));
	assert.notEqual(jsonPath("", ""), "");
	assert.deepEqual(jsonEntries([false, 0]), [["0", false], ["1", 0]]);
	assert.deepEqual(jsonEntries({ "a/b": null }), [["a/b", null]]);
	assert.deepEqual(jsonEntries(null), []);
});

test("long JSON strings resolve to full text, with an independent collapse preview", () => {
	const full = 'Use "derived from".\nC:\\assets\\still.png\n' + "instructions ".repeat(100);
	const value = `preview… ${traceBlobMark(HASH, full.length)}`;
	assert.deepEqual(jsonString(value, { [HASH]: full }), { text: full, preview: "preview…", missing: false, expandable: true });
	assert.deepEqual(jsonString(value, {}), { text: "preview…", preview: "preview…", missing: true, expandable: false });
	assert.deepEqual(jsonString("short"), { text: "short", preview: "short", missing: false, expandable: false });
	const regular = jsonString("x".repeat(1000));
	assert.equal(regular.text.length, 1000); assert.equal(regular.preview.length, 601); assert.equal(regular.expandable, true);
});

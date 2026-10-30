import assert from "node:assert/strict";
import { test } from "node:test";
import { splitTraceBlobs, traceBlobMark } from "../src/trace/trace-blob.ts";
import { TracePrivacy } from "../src/trace/trace-privacy.ts";

const HASH = "0123456789abcdef";

test("JSON previews are grouped with their references and expansion replaces the complete value", () => {
	const full = 'You are Loom. Use "derived from".\nWindows: C:\\assets\\still.png\n' + "More instructions. ".repeat(100);
	const preview = full.slice(0, 60);
	const text = JSON.stringify({ role: "system", sections: { preamble: `${preview}… ${traceBlobMark(HASH, full.length)}`, skills: "short" } }, null, 2);
	const parts = splitTraceBlobs(text);
	const reference = parts.find((part) => "hash" in part)!;
	assert.ok("hash" in reference);
	assert.equal(reference.previewJson, JSON.stringify(`${preview}…`));
	assert.equal(reference.hash, HASH);
	const collapsed = parts.map((part) => "text" in part ? part.text : part.previewJson).join("");
	const expanded = parts.map((part) => "text" in part ? part.text : JSON.stringify(full)).join("");
	assert.equal(JSON.parse(collapsed).sections.preamble, `${preview}…`);
	assert.deepEqual(JSON.parse(expanded), { role: "system", sections: { preamble: full, skills: "short" } });
	assert.equal(expanded.split("You are Loom.").length - 1, 1);
	assert.ok(!expanded.includes(traceBlobMark(HASH, full.length)));
});

test("multiple references preserve surrounding JSON and independent previews", () => {
	const mark = traceBlobMark(HASH, 1000);
	const text = JSON.stringify({ a: `first… ${mark}`, b: ["normal", `second… ${mark}`] }, null, 2);
	const parts = splitTraceBlobs(text);
	const refs = parts.filter((part) => "hash" in part);
	assert.equal(refs.length, 2);
	assert.deepEqual(refs.map((part) => part.previewJson), ['"first…"', '"second…"']);
	assert.deepEqual(JSON.parse(parts.map((part) => "text" in part ? part.text : JSON.stringify("full text")).join("")), { a: "full text", b: ["normal", "full text"] });
});

test("plain text, bare markers and an empty preview remain readable", () => {
	assert.deepEqual(splitTraceBlobs("plain text"), [{ text: "plain text" }]);
	assert.deepEqual(splitTraceBlobs(""), []);
	assert.deepEqual(splitTraceBlobs(`before ${traceBlobMark(HASH, 20)} after`), [{ text: "before " }, { hash: HASH, length: 20 }, { text: " after" }]);
	assert.deepEqual(splitTraceBlobs(JSON.stringify(`… ${traceBlobMark(HASH, 20)}`)), [{ hash: HASH, length: 20, previewJson: '"…"' }]);
});

test("real recorded requests can expand to redacted JSON without repeating previews", () => {
	const privacy = new TracePrivacy(); privacy.setSecrets(["private-test-value"]);
	const preamble = 'You are Loom. Say "hello".\n'.repeat(100) + "private-test-value";
	const blobs: Record<string, string> = {};
	const text = privacy.request([{ role: "system", sections: { preamble } }, { role: "user", content: "Question" }], (hash, full) => { blobs[hash] = full; });
	const expanded = splitTraceBlobs(text).map((part) => "text" in part ? part.text : JSON.stringify(blobs[part.hash])).join("");
	assert.deepEqual(JSON.parse(expanded), [{ role: "system", sections: { preamble: preamble.replace("private-test-value", "[redacted]") } }, { role: "user", content: "Question" }]);
	assert.ok(!expanded.includes("private-test-value"));
});

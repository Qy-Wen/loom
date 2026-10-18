import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseByteRange } from "../src/main/desktop/byte-range.ts";

describe("parseByteRange", () => {
	it("parses bounded, open-ended, and suffix ranges", () => {
		assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
		assert.deepEqual(parseByteRange("bytes=90-", 100), { start: 90, end: 99 });
		assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
	});

	it("clamps an end beyond the file size", () => {
		assert.deepEqual(parseByteRange("bytes=90-200", 100), { start: 90, end: 99 });
	});

	it("rejects malformed and unsatisfiable ranges", () => {
		assert.equal(parseByteRange(null, 100), null);
		assert.equal(parseByteRange("bytes=20-10", 100), null);
		assert.equal(parseByteRange("bytes=100-", 100), null);
		assert.equal(parseByteRange("bytes=0-1,4-5", 100), null);
		assert.equal(parseByteRange("bytes=-0", 100), null);
	});
});

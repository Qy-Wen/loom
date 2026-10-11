import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFileNameW, dropEffectIsMove } from "../src/shared/file-clipboard.ts";

describe("file clipboard formats", () => {
	it("reads one UTF-16 path and ignores trailing nulls", () => {
		const encoded = Buffer.from("C:\\shots\\a.txt\0\0", "utf16le");
		assert.equal(decodeFileNameW(encoded), "C:\\shots\\a.txt");
		assert.equal(decodeFileNameW(Buffer.alloc(0)), "");
	});

	it("treats drop effect 2 as a move", () => {
		assert.equal(dropEffectIsMove(Buffer.from([2, 0, 0, 0])), true);
		assert.equal(dropEffectIsMove(Buffer.from([5, 0, 0, 0])), false);
		assert.equal(dropEffectIsMove(Buffer.from([1, 0, 0, 0])), false);
		assert.equal(dropEffectIsMove(Buffer.alloc(0)), false);
	});
});

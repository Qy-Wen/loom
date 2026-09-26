import assert from "node:assert/strict";
import { test } from "node:test";
import { rerankHits } from "../src/retrieval/rerank.ts";

test("rerankHits orders by score and keeps ties stable", () => {
	const ranked = rerankHits(
		[{ id: "a" }, { id: "b" }, { id: "c" }],
		[0.2, 0.9, 0.2],
	);
	assert.deepEqual(ranked.map((item) => item.id), ["b", "a", "c"]);
	assert.equal(ranked[0]?.score, 0.9);
});

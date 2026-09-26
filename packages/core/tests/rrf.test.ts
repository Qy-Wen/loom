import assert from "node:assert/strict";
import { test } from "node:test";
import { cosineDistance, RRF_K, rrfFuse, uniqueInOrder } from "../src/retrieval/rrf.ts";

test("rrfFuse scores a hit in both lists higher than a single-list hit", () => {
	const fused = rrfFuse([["a", "b"], ["a", "c"]]);
	assert.equal(fused[0]?.id, "a");
	assert.equal(fused[0]?.score, 2 / (RRF_K + 1));
	assert.deepEqual(fused.slice(1).map((item) => item.id).sort(), ["b", "c"]);
	assert.equal(fused[1]?.score, 1 / (RRF_K + 2));
});

test("rrfFuse keeps a one-list hit", () => {
	const fused = rrfFuse([["only"], []]);
	assert.deepEqual(fused, [{ id: "only", score: 1 / (RRF_K + 1) }]);
});

test("uniqueInOrder drops later duplicates", () => {
	assert.deepEqual(uniqueInOrder(["b", "a", "b", "c"]), ["b", "a", "c"]);
});

test("cosineDistance is 0 for the same vector", () => {
	assert.equal(cosineDistance([1, 0], [1, 0]), 0);
	assert.ok(cosineDistance([1, 0], [0, 1]) > 0.99);
});

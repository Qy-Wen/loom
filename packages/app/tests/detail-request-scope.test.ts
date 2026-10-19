import assert from "node:assert/strict";
import { test } from "node:test";
import { DetailRequestScope } from "../src/renderer/details/request-scope.ts";

test("detail results, errors and finalizers expire on selection changes including A to B to A", () => {
	const scope = new DetailRequestScope();
	scope.select("a");
	const previous = scope.request("describe-action", "a");
	scope.select("b"); scope.select("a");
	const next = scope.request("describe-action", "a");
	assert.equal(previous(), false);
	assert.equal(next(), true);
});

test("reopening the same library and asset invalidates old detail reads", () => {
	const scope = new DetailRequestScope();
	scope.select("asset");
	const library = scope.libraryGuard(), read = scope.request("image", "asset");
	scope.resetLibrary(); scope.select("asset");
	assert.equal(library(), false);
	assert.equal(read(), false);
	assert.equal(scope.request("image", "asset")(), true);
});

test("newer status reads replace old reads without invalidating other status lanes", () => {
	const scope = new DetailRequestScope();
	scope.select("asset");
	const image = scope.request("image", "asset"), embed = scope.request("embed", "asset");
	const newer = scope.request("image", "asset");
	assert.equal(image(), false); assert.equal(newer(), true); assert.equal(embed(), true);
});

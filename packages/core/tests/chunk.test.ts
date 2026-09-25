import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHILD_TOKEN_LIMIT, PARENT_TOKEN_LIMIT } from "../src/model/text-embed.ts";
import { chunkMarkdown } from "../src/rag/chunk.ts";
import { countTokens } from "../src/rag/tokenize.ts";

function fillTokens(min: number): string {
	const parts: string[] = [];
	let index = 0;
	while (countTokens(parts.join(" ")) < min) {
		const batch: string[] = [];
		for (let step = 0; step < 80; step += 1, index += 1) batch.push(`word${index}`);
		parts.push(batch.join(" "));
	}
	return parts.join(" ");
}

describe("chunkMarkdown", () => {
	it("keeps a short file as one child and one parent", () => {
		const source = "# Title\n\nHello world.\n";
		const plan = chunkMarkdown(source);
		assert.equal(plan.parents.length, 1);
		assert.equal(plan.parents[0]?.children.length, 1);
		assert.match(plan.parents[0]!.text, /Title/);
		assert.match(plan.parents[0]!.text, /Hello world/);
		assert.equal(plan.parents[0]?.children[0]?.text, plan.parents[0]?.text);
	});

	it("windows a long unit at 512 with 64 overlap", () => {
		const source = fillTokens(600);
		const plan = chunkMarkdown(source);
		const children = plan.parents.flatMap((parent) => parent.children);
		assert.ok(children.length >= 2);
		assert.ok(children.every((child) => child.tokenCount <= CHILD_TOKEN_LIMIT));
		const first = children[0]!;
		const second = children[1]!;
		assert.ok(second.start > first.start);
		assert.ok(second.start < first.end);
	});

	it("packs consecutive children into parents up to 2048 source tokens", () => {
		const source = fillTokens(2200);
		const plan = chunkMarkdown(source);
		assert.ok(plan.parents.length >= 2);
		assert.ok(plan.parents.every((parent) => parent.tokenCount <= PARENT_TOKEN_LIMIT));
		for (const parent of plan.parents) {
			assert.equal(parent.text, source.slice(parent.start, parent.end));
			assert.ok(parent.children.length >= 1);
			assert.equal(parent.children[0]?.start, parent.start);
			assert.equal(parent.children.at(-1)?.end, parent.end);
		}
	});

	it("treats a fenced code block as one structural unit when it fits", () => {
		const source = "Intro paragraph.\n\n```js\nconst x = 1;\n```\n";
		const plan = chunkMarkdown(source);
		assert.equal(plan.parents.length, 1);
		assert.equal(plan.parents[0]?.children.length, 1);
		assert.match(plan.parents[0]!.text, /```js/);
	});
});

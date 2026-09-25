import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactTranscript, compactionRate, longTranscript } from "../evals/compaction-rate.ts";
import { CACHE_PAD_CHARS, cacheHitFromUsage, paddedSystemPrompt } from "../evals/prompt-cache-hit.ts";

describe("compactionRate", () => {
	it("is after tokens over before tokens", () => {
		assert.equal(compactionRate(1000, 250), 0.25);
		assert.equal(compactionRate(0, 10), 0);
	});
});

describe("compactTranscript", () => {
	it("shrinks a long session below the original context length", () => {
		const result = compactTranscript(longTranscript(), 400);
		assert.ok(result.tokensBefore > result.tokensAfter);
		assert.ok(result.rate > 0 && result.rate < 1);
		assert.ok(result.dropped > 0);
	});
});

describe("paddedSystemPrompt", () => {
	it("is long enough to land above 150k tokens", () => {
		assert.ok(paddedSystemPrompt().length >= CACHE_PAD_CHARS);
	});
});

describe("cacheHitFromUsage", () => {
	it("uses cacheRead over the API prompt token sum", () => {
		const hit = cacheHitFromUsage({ input: 177, cacheRead: 768, cacheWrite: 0, output: 20 });
		assert.equal(hit.promptTokens, 945);
		assert.ok(Math.abs(hit.hit - 768 / 945) < 1e-9);
	});

	it("is zero when the API reports no cache read", () => {
		assert.equal(cacheHitFromUsage({ input: 900, cacheRead: 0, cacheWrite: 0, output: 10 }).hit, 0);
	});
});

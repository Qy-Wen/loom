import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLoomAgent } from "../src/pi-adapter.ts";

describe("createLoomAgent", () => {
	it("rejects an unknown provider/model pair before a run starts", () => {
		assert.throws(
			() => createLoomAgent({ model: { provider: "missing", model: "missing" } }),
			/Unknown model: missing\/missing/,
		);
	});
});

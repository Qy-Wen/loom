import assert from "node:assert/strict";
import { test } from "node:test";
import { toDurableTool } from "@loom/agent";
import { TracePrivacy } from "../../agent/src/trace/trace-privacy.ts";
import { createSettingsTools } from "../src/main/tools/settings-tools.ts";
import { capturedTools } from "../src/renderer/dev-trace/trace-events.ts";

// Regression for the real definition that was previously clipped by message budget, depth and headers filtering.
test("update_settings survives capture and viewer projection with its complete historical schema", () => {
	const tools = createSettingsTools({ read: async () => { throw new Error("not called"); }, apply: async () => { throw new Error("not called"); } }).map(toDurableTool);
	const privacy = new TracePrivacy();
	const blobs: Record<string, string> = {};
	const snapshot = privacy.requestTools([{ role: "system", content: "", toolsAdded: tools, timestamp: 0 }], (hash, text) => { blobs[hash] = text; });
	const captured = capturedTools(undefined, snapshot, blobs);
	assert.equal(captured.captured, true); assert.equal(captured.incomplete, false);
	assert.deepEqual(captured.definitions.map((tool) => typeof tool === "object" && tool !== null && !Array.isArray(tool) ? tool.parameters : undefined), tools.map((tool) => JSON.parse(JSON.stringify(tool.parameters))));
	assert.match(snapshot, /"headers"/); assert.match(snapshot, /"apiKey"/);
	assert.doesNotMatch(snapshot, /\[omitted\]|trace content omitted|bytes cut/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { toolResultContent, toAgUiMessages } from "../src/shared/ag-ui-messages.ts";
import { toolResultParts } from "../src/shared/tool-result-content.ts";

test("image tool results survive AG-UI serialization and history conversion", () => {
	const content = [{ type: "text", text: "Scan to log in" }, { type: "image", data: "YWJj", mimeType: "image/png" }, { type: "image", data: "ZGVm", mimeType: "image/jpeg" }];
	const live = toolResultContent(content);
	assert.deepEqual(toolResultParts(live), content);
	assert.deepEqual(toolResultParts(content), content);
	assert.deepEqual(toolResultParts({ content }), content);
	const [message] = toAgUiMessages([{ role: "toolResult", toolCallId: "1/image", content }]);
	assert.ok(message?.role === "tool");
	assert.equal(message.content, live);
	assert.equal(message.toolCallId, "1/image");
});

test("ordinary results keep their existing text representation", () => {
	assert.equal(toolResultContent([{ type: "text", text: "one" }, { type: "text", text: "two" }]), "onetwo");
	for (const result of ["plain text", '{"assets":[]}', "", null, { content: "text" }, [{ type: "text", text: "text" }]]) {
		assert.equal(toolResultParts(result), null);
	}
	assert.equal(toolResultContent("plain text"), "plain text");
});

test("image previews ignore malformed blocks and unsafe MIME strings", () => {
	for (const image of [
		{ type: "image", mimeType: "image/png" },
		{ type: "image", mimeType: "image/png", data: "" },
		{ type: "image", mimeType: "text/html", data: "YWJj" },
		{ type: "image", mimeType: "image/png;injected", data: "YWJj" },
	]) assert.equal(toolResultParts(JSON.stringify({ content: [image] })), null);
});

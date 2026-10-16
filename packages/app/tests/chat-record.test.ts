import assert from "node:assert/strict";
import { test } from "node:test";
import { chatContent, chatRecord } from "../src/main/chat-record.ts";
import { toAgUiMessages } from "../src/shared/ag-ui-messages.ts";
import { toolResultParts } from "../src/shared/tool-result-content.ts";

test("chat records reference even very large images without changing durable content", () => {
	const data = "a".repeat(11 * 1024 * 1024);
	const content = [{ type: "text", text: "image result" }, { type: "image", data, mimeType: "image/png" }];
	const original = { id: "1", title: "history", status: "open" as const, createdAt: 1, updatedAt: 2, context: undefined, messages: [{ id: "2", role: "toolResult", toolCallId: "1/tool", content }] };
	const record = chatRecord(original);
	assert.equal(original.messages[0]!.content[1]!.data, data);
	assert.ok(JSON.stringify(record).length < 1024);
	const message = toAgUiMessages(record.messages)[0]!;
	assert.deepEqual(toolResultParts(message.content), [{ type: "text", text: "image result" }, { type: "image", url: "loom-asset://chat-image/1/2/1", mimeType: "image/png" }]);
	assert.equal(chatContent("plain", "1", "2"), "plain");
});

test("image references accept only the chat media protocol", () => {
	for (const url of ["https://example.com/image.png", "file:///etc/passwd", "javascript:alert(1)", "loom-asset://chat-image/../2/0"]) {
		assert.equal(toolResultParts([{ type: "image", url, mimeType: "image/png" }]), null);
	}
});

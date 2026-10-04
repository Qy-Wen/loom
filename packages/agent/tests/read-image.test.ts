import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, type AgentHarnessToolInvocation, type JsonValue } from "#vendor/pi-agent";
import { processReadImageBytes } from "../src/read-image.ts";
import { createWorkspaceTools } from "../src/pi-tools.ts";

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function bmp(width: number, height: number): Buffer {
	const row = Math.ceil((24 * width) / 32) * 4;
	const offset = 54;
	const bytes = Buffer.alloc(offset + row * height);
	bytes.write("BM", 0);
	bytes.writeUInt32LE(bytes.length, 2);
	bytes.writeUInt32LE(offset, 10);
	bytes.writeUInt32LE(40, 14);
	bytes.writeInt32LE(width, 18);
	bytes.writeInt32LE(height, 22);
	bytes.writeUInt16LE(1, 26);
	bytes.writeUInt16LE(24, 28);
	bytes[54] = 255;
	return bytes;
}

test("small PNG stays PNG and a small BMP becomes PNG", async () => {
	const png = await processReadImageBytes(PNG_1X1, "image/png");
	assert.equal(png.ok, true);
	if (!png.ok) return;
	assert.equal(png.mimeType, "image/png");
	assert.deepEqual(png.hints, []);
	assert.equal(png.data, PNG_1X1.toString("base64"));

	const converted = await processReadImageBytes(bmp(1, 1), "image/bmp");
	assert.equal(converted.ok, true);
	if (!converted.ok) return;
	assert.equal(converted.mimeType, "image/png");
	assert.deepEqual(converted.hints, ["[Image converted from image/bmp to image/png.]"]);
	assert.match(Buffer.from(converted.data, "base64").subarray(0, 8).toString("hex"), /^89504e47/);
});

test("images past the size limit are scaled and the read tool attaches the result", async () => {
	const wide = await processReadImageBytes(bmp(4, 2), "image/bmp", { maxWidth: 2, maxHeight: 2 });
	assert.equal(wide.ok, true);
	if (!wide.ok) return;
	assert.equal(wide.mimeType, "image/png");
	assert.match(wide.hints.join("\n"), /converted from image\/bmp/);
	assert.match(wide.hints.join("\n"), /original 4x2, displayed at 2x1/);

	const root = await mkdtemp(join(tmpdir(), "loom-read-image-"));
	try {
		await writeFile(join(root, "dot.bmp"), bmp(1, 1));
		const workspace = createWorkspaceTools(root);
		const read = workspace.tools.find((tool) => tool.name === "read");
		assert.ok(read);
		const memos = new Map<string, JsonValue>();
		const invocation: AgentHarnessToolInvocation = {
			invocationId: "test-invocation",
			operationId: "test-operation",
			turnId: "test-turn",
			getMemo: async (name) => memos.get(name),
			setMemo: async (name, value) => {
				if (value === undefined) memos.delete(name);
				else memos.set(name, value);
			},
		};
		const shown = await read.execute("read-bmp", { path: "dot.bmp" }, () => {}, workspace.toolContext, invocation, BACKGROUND_CONTEXT);
		const text = shown.content.find((part) => part.type === "text");
		const image = shown.content.find((part) => part.type === "image");
		assert.match(text?.type === "text" ? text.text : "", /Read image file \[image\/png\]/);
		assert.match(text?.type === "text" ? text.text : "", /converted from image\/bmp/);
		assert.equal(image?.type === "image" ? image.mimeType : "", "image/png");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

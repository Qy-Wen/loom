import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { TracePrivacy } from "../src/trace/trace-privacy.ts";
import { traceBlobReference } from "../src/trace/trace-blob.ts";

const tool = (name: string, parameters: Tool["parameters"] = Type.Object({})): Tool => ({ name, description: `Description of ${name}`, parameters });
function capture(messages: Message[], privacy = new TracePrivacy()) {
	const blobs: Record<string, string> = {};
	const tools = JSON.parse(privacy.requestTools(messages, (hash, text) => { blobs[hash] = text; }));
	const input = JSON.parse(privacy.request(messages, (hash, text) => { blobs[hash] = text; }));
	return { tools, input, blobs };
}

test("tool definitions have an independent budget, without registry or schema field-count clipping", () => {
	const parameters = Type.Object(Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`field_${i}`, Type.String({ description: "Field details ".repeat(20) })])));
	const definitions = Array.from({ length: 240 }, (_, i) => tool(`tool_${i}`, i === 0 ? parameters : Type.Object({})));
	const messages: Message[] = [{ role: "system", content: "prompt", toolsAdded: definitions, timestamp: 0 }];
	const result = capture(messages);
	assert.deepEqual(result.tools, JSON.parse(JSON.stringify(definitions)));
	assert.equal(result.tools.length, 240);
	assert.equal(Object.keys(result.tools[0].parameters.properties).length, 250);
	assert.ok(Buffer.byteLength(JSON.stringify(result.tools)) > 32 * 1024);
	assert.ok(Buffer.byteLength(JSON.stringify(result.input[0])) <= 32 * 1024);
	assert.ok(!JSON.stringify(result.input).includes("Field details")); // No second, partial copy in the prompt budget.
	assert.doesNotMatch(JSON.stringify(result.tools), /omitted|bytes cut/);
});

test("deep schema declarations retain credential-like field names and shared sub-schemas", () => {
	const shared = Type.String({ description: "API credential supplied by the user" });
	let nested: Tool["parameters"] = Type.Object({ headers: Type.Record(Type.String(), Type.String()), apiKey: shared, password: shared, signature: shared, default: Type.String({ default: "ordinary default" }) });
	for (let i = 0; i < 20; i++) nested = Type.Object({ nested });
	const definition = tool("update_settings", nested);
	const result = capture([{ role: "system", content: "", toolsAdded: [definition], timestamp: 0 }]);
	assert.deepEqual(result.tools, JSON.parse(JSON.stringify([definition])));
	assert.doesNotMatch(JSON.stringify(result.tools), /omitted/);
});

test("real secrets in descriptions, defaults and examples are still redacted; long text uses deduplicated blobs", () => {
	const privacy = new TracePrivacy(); privacy.setSecrets(["private-test-value"]);
	const long = "Description 汉🙂 ".repeat(2000) + "private-test-value";
	const definition = { ...tool("settings", Type.Object({ apiKey: Type.String(), headers: Type.Object({ authorization: Type.String() }) }, { examples: [{ apiKey: "EXAMPLE_KEY", password: "EXAMPLE_PASSWORD", headers: { authorization: "EXAMPLE_HEADER" } }], default: { apiKey: "DEFAULT_KEY" } })), description: long };
	const messages: Message[] = [{ role: "system", content: "", toolsAdded: [definition, { ...definition, name: "other" }], timestamp: 0 }];
	const result = capture(messages, privacy);
	assert.equal(result.tools[0].parameters.properties.apiKey.type, "string");
	assert.equal(result.tools[0].parameters.properties.headers.properties.authorization.type, "string");
	assert.equal(result.tools[0].parameters.examples[0].apiKey, "[redacted]");
	assert.equal(result.tools[0].parameters.examples[0].password, "[redacted]");
	assert.equal(result.tools[0].parameters.examples[0].headers, "[omitted]");
	assert.equal(result.tools[0].parameters.default.apiKey, "[redacted]");
	assert.equal(Object.keys(result.blobs).length, 1);
	const reference = traceBlobReference(result.tools[0].description)!;
	assert.equal(result.blobs[reference.hash], long.replaceAll("private-test-value", "[redacted]"));
	assert.doesNotMatch(JSON.stringify(result), /private-test-value|EXAMPLE_KEY|EXAMPLE_PASSWORD|EXAMPLE_HEADER|DEFAULT_KEY/);
});

test("the historical tool snapshot resolves all deltas before dropping old request messages", () => {
	const kept = tool("kept"), removed = tool("removed"), replacement = { ...tool("replaced"), description: "NEW" };
	const messages: Message[] = [
		{ role: "system", content: "", toolsAdded: [kept, removed, tool("replaced")], timestamp: 0 },
		...Array.from({ length: 205 }, (_, i): Message => ({ role: "user", content: `user_${i}`, timestamp: i })),
		{ role: "system", content: "", toolsRemoved: [{ name: "removed" }], toolsAdded: [replacement], timestamp: 206 },
	];
	const result = capture(messages);
	assert.deepEqual(result.tools, JSON.parse(JSON.stringify([kept, replacement])));
	assert.match(result.input[0], /earlier messages omitted/);
	assert.deepEqual(capture([{ role: "system", content: "", toolsAdded: [kept], timestamp: 0 }, { role: "system", content: "", toolsRemoved: [{ name: "kept" }], timestamp: 1 }]).tools, []);
});

test("runaway definitions retain explicit omissions and do not prevent other tools from being captured", () => {
	let deep: Record<string, unknown> = { type: "string" };
	for (let i = 0; i < 70; i++) deep = { type: "object", properties: { next: deep } };
	const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
	const definitions = [tool("deep", Type.Unsafe(deep)), tool("huge", Type.Object({ ["x".repeat(4 * 1024 * 1024)]: Type.String() })), tool("cycle", cyclic as Tool["parameters"]), tool("normal"), tool("nodes", Type.Unsafe({ enum: Array.from({ length: 100_005 }, (_, i) => i) }))];
	const { tools } = capture([{ role: "system", content: "", toolsAdded: definitions, timestamp: 0 }]);
	assert.deepEqual(tools.map((item: Tool) => item.name), ["deep", "huge", "cycle", "normal", "nodes"]);
	assert.match(JSON.stringify(tools[0]), /\[omitted\]/);
	assert.ok(Buffer.byteLength(JSON.stringify(tools[1])) <= 4 * 1024 * 1024);
	assert.match(JSON.stringify(tools[1]), /trace content omitted/);
	assert.equal(tools[2].definition, "[unserializable]");
	assert.deepEqual(tools[3], JSON.parse(JSON.stringify(definitions[3])));
	assert.equal(tools[4].parameters.enum.at(-1), "… (trace content omitted)");
});

test("over-limit definition text uses a valid UTF-8 blob with an explicit clipping notice", () => {
	const definition = { ...tool("long"), description: "汉🙂".repeat(610_000) };
	const { tools, blobs } = capture([{ role: "system", content: "", toolsAdded: [definition], timestamp: 0 }]);
	const reference = traceBlobReference(tools[0].description)!;
	const full = blobs[reference.hash]!;
	assert.match(full, /\n… \(\d+ bytes cut\)$/);
	assert.doesNotMatch(full, /\uFFFD/);
	assert.ok(Buffer.byteLength(full) <= 4 * 1024 * 1024 + 100);
	assert.ok(reference.length > full.length);
});

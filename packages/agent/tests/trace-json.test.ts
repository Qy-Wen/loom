import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedTraceJson } from "../src/trace/trace-json.ts";
import { TracePrivacy } from "../src/trace/trace-privacy.ts";

function bounded(value: unknown, limit: number): unknown {
	const text = boundedTraceJson(value, limit);
	assert.ok(Buffer.byteLength(text) <= limit, `${Buffer.byteLength(text)} > ${limit}`);
	assert.doesNotMatch(text, /\uFFFD/);
	return JSON.parse(text);
}

test("bounded JSON preserves complete values, using compact syntax before omitting data", () => {
	const value = { nested: [{ ok: true, missing: null, text: "hello" }], number: 0 };
	assert.equal(boundedTraceJson(value, 8192), JSON.stringify(value, null, 2));
	assert.deepEqual(bounded(value, Buffer.byteLength(JSON.stringify(value))), value);
});

test("UTF-8 and JSON escapes fit the byte budget without broken strings or brackets", () => {
	const values = [
		"汉🙂\"\\\n".repeat(4000),
		{ body: "汉🙂\"\\\n".repeat(4000) },
		Array.from({ length: 100 }, (_, i) => ({ index: i, body: "x".repeat(500) })),
		Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field-${i}`, { text: "汉".repeat(500) }])),
		{ ["long-key".repeat(1000)]: "body", tail: true },
	];
	for (const limit of [64, 128, 256, 512, 1024, 8192]) {
		for (const value of values) bounded(value, limit);
	}
	assert.match(boundedTraceJson(values[0], 8192), /bytes cut/);
});

test("omission notices do not overwrite a user's similarly named field", () => {
	const value = { "… (trace omitted)": "user field", ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field-${i}`, "content".repeat(100)])) };
	const result = bounded(value, 256) as Record<string, unknown>;
	assert.equal(result["… (trace omitted)"], "user field");
	assert.equal(result["… (trace omitted)…"], "… (trace content omitted)");
});

test("request messages and ordinary payloads keep valid JSON with the existing limits", () => {
	const privacy = new TracePrivacy(); privacy.setSecrets(["trace-private-value"]);
	const ordinary = privacy.value({ body: "汉🙂\"\\\n".repeat(4000), token: "trace-private-value" });
	assert.ok(Buffer.byteLength(ordinary) <= 8192);
	assert.ok(!ordinary.includes("trace-private-value"));
	assert.doesNotThrow(() => JSON.parse(ordinary));
	const messages = [
		{ role: "system", tools: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`tool-${i}`, { arguments: Array.from({ length: 200 }, (_, j) => ({ name: `argument-${j}`, optional: true })) }])) },
		{ role: "user", content: "KEEP_THE_LATEST_QUESTION" },
	];
	const request = privacy.request(messages, () => {});
	const parsed = JSON.parse(request);
	assert.equal(parsed[1].content, "KEEP_THE_LATEST_QUESTION");
	assert.ok(Buffer.byteLength(JSON.stringify(parsed[0])) <= 32 * 1024);
	assert.match(request, /trace content omitted/);
});

test("structural clipping reports omitted items, bounds depth and still redacts keys and images", () => {
	const privacy = new TracePrivacy(); privacy.setSecrets(["trace-private-value"]);
	const array = JSON.parse(privacy.value(Array.from({ length: 201 }, () => 0)));
	assert.equal(array.length, 201); assert.equal(array[200], "… (1 items omitted)");
	const object = JSON.parse(privacy.value(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, 0]))));
	assert.equal(object["… (trace omitted)"], "… (1 fields omitted)");
	const cycle: Record<string, unknown> = {}; cycle.self = cycle;
	assert.equal(JSON.parse(privacy.value(cycle)).self, "[omitted]");
	const nested: Record<string, unknown> = {}; let current = nested;
	for (let i = 0; i < 20; i++) { const next = {}; current.child = next; current = next; }
	assert.match(privacy.value(nested), /\[omitted\]/);
	const safe = privacy.value({ "trace-private-value": "safe", image: { type: "image", data: "PRIVATE_IMAGE", mimeType: "trace-private-value" } });
	assert.ok(!safe.includes("trace-private-value")); assert.ok(!safe.includes("PRIVATE_IMAGE"));
	assert.doesNotThrow(() => JSON.parse(safe));
	assert.equal(JSON.parse(privacy.value({ unsupported: 1n })), "[unserializable]");
});

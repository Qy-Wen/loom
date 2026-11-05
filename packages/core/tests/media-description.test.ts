import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaDescriptionMarkdown, parseMediaDescriptionJson } from "../src/model/media-description.ts";

test("structured descriptions retain tags and transcript when indexed", () => {
	const description = parseMediaDescriptionJson(JSON.stringify({
		caption: " A person speaks over quiet music. ", tags: [" Music ", "music", "Speech, English"], transcript: "00:01 Hello.",
	}), true);
	assert.deepEqual(description, { caption: "A person speaks over quiet music.", tags: ["Music", "Speech, English"], transcript: "00:01 Hello." });
	assert.match(mediaDescriptionMarkdown(description), /Speech, English/);
	assert.match(mediaDescriptionMarkdown(description), /00:01 Hello/);
});

test("malformed model responses are rejected before storing descriptions or suggesting tags", () => {
	for (const input of ["not JSON", "[]", '{"caption":"","tags":[]}', '{"caption":"ok","tags":"tag"}', '{"caption":"ok","tags":[1]}', '{"caption":"ok","tags":["a\\nb"]}']) {
		assert.throws(() => parseMediaDescriptionJson(input));
	}
	assert.throws(() => parseMediaDescriptionJson('{"caption":"ok","tags":[]}', true), /transcript/);
	assert.equal(parseMediaDescriptionJson('{"caption":"Music","tags":[],"transcript":null}', true).transcript, null);
});

test("a single wrapping code fence around the JSON is accepted", () => {
	const json = '{"caption":"A cat","tags":["cat"]}';
	for (const raw of [`\`\`\`json\n${json}\n\`\`\``, `\`\`\`\n${json}\n\`\`\`\n`, `  \`\`\`JSON\r\n${json}\r\n\`\`\`  `]) {
		assert.deepEqual(parseMediaDescriptionJson(raw), { caption: "A cat", tags: ["cat"] });
	}
	assert.throws(() => parseMediaDescriptionJson(`Here you go:\n\`\`\`json\n${json}\n\`\`\``), /JSON/);
});

test("old Markdown and plain captions are rejected", () => {
	assert.throws(() => parseMediaDescriptionJson("## Caption\nOld caption\n## Tags\nlandscape, blue"), /JSON/);
	assert.throws(() => parseMediaDescriptionJson("A plain caption"), /JSON/);
});

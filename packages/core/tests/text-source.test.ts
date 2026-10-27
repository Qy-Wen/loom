import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { LocalCore } from "../src/local-core.ts";
import { chunkMarkdown } from "../src/rag/chunk.ts";
import { canIndexText, csvToMarkdown, jsonToMarkdown, textToMarkdown } from "../src/rag/text-source.ts";

describe("canIndexText", () => {
	it("accepts md, txt, csv, and json only", () => {
		for (const name of ["a.md", "a.TXT", "a.csv", "a.json"]) assert.equal(canIndexText(name), true, name);
		for (const name of ["a.html", "a.pdf", "a.docx", "a"]) assert.equal(canIndexText(name), false, name);
	});

	it("leaves txt and md unchanged", () => {
		assert.equal(textToMarkdown("a.txt", "one\n\ntwo\n"), "one\n\ntwo\n");
		assert.equal(textToMarkdown("a.md", "# T\n"), "# T\n");
	});
});

describe("csvToMarkdown", () => {
	it("puts the column names on every row", () => {
		assert.equal(
			csvToMarkdown("name,age\nAnn,3\nBob,4\n"),
			"name: Ann; age: 3\n\nname: Bob; age: 4\n",
		);
	});

	it("handles quoted commas, doubled quotes, line breaks, BOM and CRLF", () => {
		const csv = "\uFEFFname,note\r\nAnn,\"likes cats, dogs\"\r\nBob,\"said \"\"hi\"\"\nthen left\"\r\n";
		assert.equal(
			csvToMarkdown(csv),
			"name: Ann; note: likes cats, dogs\n\nname: Bob; note: said \"hi\" then left\n",
		);
	});

	it("skips empty cells and blank lines, and names headerless columns", () => {
		assert.equal(csvToMarkdown("a,,c\n1,,3\n\n,,\n"), "a: 1; c: 3\n");
		assert.equal(csvToMarkdown("a\n1,2\n"), "a: 1; column 2: 2\n");
		assert.equal(csvToMarkdown(""), "");
		assert.equal(csvToMarkdown("only,header\n"), "");
	});

	it("drops the last row when the source was cut", () => {
		assert.equal(csvToMarkdown("a,b\n1,2\n3,", true), "a: 1; b: 2\n");
	});
});

describe("jsonToMarkdown", () => {
	it("flattens a small object into key paths", () => {
		assert.equal(
			jsonToMarkdown("{\"user\":{\"name\":\"Ann\",\"tags\":[\"a\",\"b\"]},\"n\":3,\"skip\":null}"),
			"user.name: Ann\nuser.tags[0]: a\nuser.tags[1]: b\nn: 3\n",
		);
	});

	it("splits a large array into one paragraph per element", () => {
		const users = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `user${i}`, note: "likes item ".repeat(5) }));
		const md = jsonToMarkdown(JSON.stringify({ users }));
		const paragraphs = md.trim().split("\n\n");
		assert.equal(paragraphs.length, 200);
		assert.match(paragraphs[7]!, /^users\[7\]\.id: 7\nusers\[7\]\.name: user7/);
	});

	it("handles top-level scalars and arrays", () => {
		assert.equal(jsonToMarkdown("\"hello\""), "value: hello\n");
		assert.equal(jsonToMarkdown("[1,2]"), "[0]: 1\n[1]: 2\n");
	});

	it("keeps invalid or cut-off JSON as plain text", () => {
		assert.equal(jsonToMarkdown("{\"a\": 1, \"b\":"), "{\"a\": 1, \"b\":");
	});

	it("chunks rows and elements without cutting them in half", () => {
		const rows = Array.from({ length: 400 }, (_, i) => `user${i},${20 + i % 40},City${i % 17}`);
		const md = csvToMarkdown(`name,age,city\n${rows.join("\n")}\n`);
		const children = chunkMarkdown(md).parents.flatMap((parent) => parent.children);
		assert.ok(children.length > 1);
		for (const child of children) {
			assert.match(child.text.trimStart(), /^name: /);
			assert.match(child.text.trimEnd(), /city: City\d+$/);
		}
	});
});

describe("indexing txt, csv, and json through LocalCore", () => {
	it("embeds each format and finds it by text", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-text-source-"));
		const core = new LocalCore();
		try {
			await writeFile(join(root, "notes.txt"), "The amber harvest begins in autumn.\n");
			await writeFile(join(root, "people.csv"), "name,city\nAnn,Paris\nBob,Rome\n");
			await writeFile(join(root, "config.json"), "{\"service\":{\"region\":\"zephyr\"}}");
			const snapshot = await core.openLibrary(root);
			const embedded: string[][] = [];
			const provider = {
				modelId: "test-embed",
				embed: async (batch: string[]) => { embedded.push(batch); return batch.map(() => [0.1, 0.2]); },
			};
			for (const asset of snapshot.assets) {
				const status = await core.embedTextAsset(asset.assetId, provider);
				assert.equal(status.status, "ready", asset.filename);
				assert.ok(status.childCount > 0, asset.filename);
			}
			const all = embedded.flat().join("\n");
			assert.match(all, /amber harvest/);
			assert.match(all, /name: Ann; city: Paris/);
			assert.match(all, /service\.region: zephyr/);
		} finally {
			await core.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

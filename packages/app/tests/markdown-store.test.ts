import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalCore } from "@loom/core";
import { TextFileStore } from "../src/main/storage/text-file.ts";
import { markdownAccess, MARKDOWN_EDIT_LIMIT_BYTES, MARKDOWN_LIVE_LIMIT_BYTES } from "../src/shared/markdown-file.ts";

async function withLibrary(files: Record<string, string | Buffer>, run: (context: { root: string; core: LocalCore; store: TextFileStore; id: (path: string) => Promise<string> }) => Promise<void>, format: "Markdown" | "HTML" = "Markdown"): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "loom-markdown-"));
	const core = new LocalCore();
	try {
		for (const [path, contents] of Object.entries(files)) {
			await mkdir(join(root, path, ".."), { recursive: true });
			await writeFile(join(root, path), contents);
		}
		await core.openLibrary(root);
		const assets = (await core.getLibrarySnapshot()).assets;
		await run({
			root,
			core,
			store: new TextFileStore(core, format),
			id: async (path) => assets.find((asset) => asset.relativePath === path)!.assetId,
		});
	} finally {
		await core.close?.();
		await rm(root, { recursive: true, force: true, maxRetries: 3 });
	}
}

test("read and save round-trip text and report the new revision", async () => {
	await withLibrary({ "笔记/a.md": "# 标题\n\n正文\n" }, async ({ root, store, id }) => {
		const a = await id("笔记/a.md");
		const first = await store.read(a);
		assert.equal(first.text, "# 标题\n\n正文\n");
		const saved = await store.save(a, "# 标题\n\n正文已改\n", first.revision);
		assert.equal(saved.status, "saved");
		assert.equal(await readFile(join(root, "笔记/a.md"), "utf8"), "# 标题\n\n正文已改\n");
		assert.equal(saved.status === "saved" && saved.snapshot.revision, (await store.read(a)).revision);
		assert.deepEqual(await readdir(join(root, "笔记")), ["a.md"]);
	});
});

test("the HTML store saves UTF-8 HTML and rejects other file types and legacy encodings", async () => {
	await withLibrary({ "page.HTM": "\uFEFF<h1>Before</h1>\r\n", "note.md": "# Note", "legacy.html": Buffer.from([0xe9]) }, async ({ root, store, id }) => {
		const page = await id("page.HTM");
		const { text, revision } = await store.read(page);
		assert.equal(text, "<h1>Before</h1>\n");
		assert.equal((await store.save(page, "<h1>After</h1>\n", revision)).status, "saved");
		assert.equal(await readFile(join(root, "page.HTM"), "utf8"), "\uFEFF<h1>After</h1>\r\n");
		await assert.rejects(store.read(await id("note.md")), /HTML file not found/);
		await assert.rejects(store.read(await id("legacy.html")), /UTF-8/);
	}, "HTML");
});

test("saving unchanged text leaves the file and its modification time alone", async () => {
	await withLibrary({ "a.md": "* one\n*   two\n\n\n" }, async ({ root, store, id }) => {
		const a = await id("a.md");
		const old = new Date("2020-01-01T00:00:00Z");
		await utimes(join(root, "a.md"), old, old);
		const { text, revision } = await store.read(a);
		const result = await store.save(a, text, revision);
		assert.equal(result.status, "saved");
		assert.equal((await stat(join(root, "a.md"))).mtimeMs, old.getTime());
		assert.equal(await readFile(join(root, "a.md"), "utf8"), "* one\n*   two\n\n\n");
	});
});

test("a file changed on disk since the read is a conflict, and nothing is overwritten", async () => {
	await withLibrary({ "a.md": "one" }, async ({ root, store, id }) => {
		const a = await id("a.md");
		const { revision } = await store.read(a);
		await writeFile(join(root, "a.md"), "changed elsewhere");
		assert.deepEqual(await store.save(a, "mine", revision), { status: "conflict" });
		assert.equal(await readFile(join(root, "a.md"), "utf8"), "changed elsewhere");
		// Reading again yields the current revision, which then saves.
		const current = await store.read(a);
		assert.equal((await store.save(a, "mine", current.revision)).status, "saved");
		assert.equal(await readFile(join(root, "a.md"), "utf8"), "mine");
	});
});

test("a BOM and CRLF line endings are kept, and the editor sees plain LF text", async () => {
	await withLibrary({ "a.md": Buffer.from("\uFEFFone\r\ntwo\r\n", "utf8"), "b.md": "x\ny\n" }, async ({ root, store, id }) => {
		const a = await id("a.md");
		const read = await store.read(a);
		assert.equal(read.text, "one\ntwo\n");
		await store.save(a, "one\ntwo\nthree\n", read.revision);
		assert.deepEqual([...await readFile(join(root, "a.md"))].slice(0, 3), [0xef, 0xbb, 0xbf]);
		assert.equal(await readFile(join(root, "a.md"), "utf8"), "\uFEFFone\r\ntwo\r\nthree\r\n");

		const b = await id("b.md");
		const readB = await store.read(b);
		await store.save(b, "x\ny\nz\n", readB.revision);
		assert.equal(await readFile(join(root, "b.md"), "utf8"), "x\ny\nz\n");
	});
});

test("a file that mixes line endings keeps the most common one", async () => {
	await withLibrary({ "a.md": "1\r\n2\r\n3\n" }, async ({ root, store, id }) => {
		const a = await id("a.md");
		const { revision } = await store.read(a);
		await store.save(a, "1\n2\n3\n4\n", revision);
		assert.equal(await readFile(join(root, "a.md"), "utf8"), "1\r\n2\r\n3\r\n4\r\n");
	});
});

test("concurrent saves from the same revision let one win and report the other as a conflict", async () => {
	await withLibrary({ "a.md": "base" }, async ({ root, store, id }) => {
		const a = await id("a.md");
		const { revision } = await store.read(a);
		const results = await Promise.all([store.save(a, "first", revision), store.save(a, "second", revision)]);
		assert.deepEqual(results.map((result) => result.status), ["saved", "conflict"]);
		assert.equal(await readFile(join(root, "a.md"), "utf8"), "first");
	});
});

test("only Markdown files of the library are readable and writable", async () => {
	await withLibrary({ "a.md": "x", "b.txt": "y", "note.canvas": "{}" }, async ({ store, id }) => {
		for (const path of ["b.txt", "note.canvas"]) await assert.rejects(store.read(await id(path)), /not found/);
		await assert.rejects(store.read("no-such-id"), /not found/);
		await assert.rejects(store.save(await id("a.md"), "x", "not-a-revision"), /revision/);
		await assert.rejects(store.save(await id("a.md"), 42 as never, "0".repeat(64)), /text/);
	});
});

test("the 2 and 10 MiB boundaries choose live, source and read-only access", () => {
	assert.equal(markdownAccess(MARKDOWN_LIVE_LIMIT_BYTES), "live");
	assert.equal(markdownAccess(MARKDOWN_LIVE_LIMIT_BYTES + 1), "source");
	assert.equal(markdownAccess(MARKDOWN_EDIT_LIMIT_BYTES), "source");
	assert.equal(markdownAccess(MARKDOWN_EDIT_LIMIT_BYTES + 1), "read");
});

test("files from 2 to 10 MiB can be read and saved, but saves cannot exceed 10 MiB", async () => {
	const text = "a".repeat(MARKDOWN_LIVE_LIMIT_BYTES + 1);
	await withLibrary({ "medium.md": text }, async ({ root, store, id }) => {
		const a = await id("medium.md");
		const read = await store.read(a);
		assert.equal(read.text, text);
		assert.equal(read.byteLength, Buffer.byteLength(text));
		const saved = await store.save(a, text + "x", read.revision);
		assert.equal(saved.status, "saved");
		assert.equal(saved.status === "saved" && saved.snapshot.byteLength, Buffer.byteLength(text) + 1);
		const current = await store.read(a);
		await assert.rejects(store.save(a, "b".repeat(MARKDOWN_EDIT_LIMIT_BYTES + 1), current.revision), /10 MiB/);
		assert.equal(await readFile(join(root, "medium.md"), "utf8"), text + "x");
	});
});

test("a file beyond 10 MiB still reads but cannot be saved, even with smaller replacement text", async () => {
	const text = "a".repeat(MARKDOWN_EDIT_LIMIT_BYTES + 1);
	await withLibrary({ "big.md": text }, async ({ root, store, id }) => {
		const a = await id("big.md");
		const read = await store.read(a);
		assert.equal(read.text, text);
		assert.equal(read.byteLength, Buffer.byteLength(text));
		await assert.rejects(store.save(a, "small", read.revision), /read-only/);
		assert.equal(await readFile(join(root, "big.md"), "utf8"), text);
	});
});

test("after another library is opened, a file of the old one cannot be saved", async (t) => {
	const other = await mkdtemp(join(tmpdir(), "loom-markdown-other-"));
	t.after(() => rm(other, { recursive: true, force: true, maxRetries: 3 }));
	await withLibrary({ "a.md": "x" }, async ({ root, core, store, id }) => {
		const a = await id("a.md");
		const { revision } = await store.read(a);
		await core.openLibrary(other);
		await assert.rejects(store.save(a, "y", revision), /not found/);
		assert.equal(await readFile(join(root, "a.md"), "utf8"), "x");
	});
});

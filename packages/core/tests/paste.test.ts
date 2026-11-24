import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { LibraryPaths, LocalCore, type Asset, type PasteConflict, type ResolvePasteConflict } from "../src/index.ts";
import { pastePaths } from "../src/library/paste.ts";
import { SqliteMetadataStore } from "../src/stores/sqlite.ts";

async function fixture(t: TestContext, files: Record<string, string>, metadataStore?: SqliteMetadataStore) {
	const directory = await mkdtemp(join(tmpdir(), "loom-paste-"));
	const root = join(directory, "library");
	await mkdir(root);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
	const core = new LocalCore({ metadataStore });
	t.after(async () => {
		await core.close();
		await rm(directory, { recursive: true, force: true });
	});
	const initial = await core.openLibrary(root);
	return { core, root, directory, initial };
}

const unexpectedConflict: ResolvePasteConflict = async () => { throw new Error("Unexpected conflict prompt"); };

test("same-directory copy uses copy suffixes for files and folders without prompting; move is a no-op", async (t) => {
	const { core, root, initial } = await fixture(t, { "note.md": "note", "bundle.v1/nested.md": "nested" });
	const sources = [join(root, "note.md"), join(root, "bundle.v1")];
	for (const suffix of ["", " 2"]) {
		const result = await core.pastePathsInto(sources, "", false, unexpectedConflict);
		assert.equal(result.assets[0]?.relativePath, `note copy${suffix}.md`);
		assert.deepEqual(result.folders, [`bundle.v1 copy${suffix}`]);
		assert.equal(result.cancelled, false);
		assert.notEqual(result.assets[0]?.assetId, initial.assets.find((asset) => asset.relativePath === "note.md")?.assetId);
	}
	const moved = await core.pastePathsInto(sources, "", true, unexpectedConflict);
	assert.equal(moved.assets[0]?.relativePath, "note.md");
	assert.deepEqual(moved.folders, ["bundle.v1"]);
});

test("cross-directory Keep Both uses numbers before file extensions, skipping occupied names", async (t) => {
	const { core, root } = await fixture(t, { "from/report.tar.gz": "new", "to/report.tar.gz": "old", "to/report.tar 2.gz": "two" });
	const conflicts: PasteConflict[] = [];
	const result = await core.pastePathsInto([join(root, "from/report.tar.gz")], "to", false, async (conflict) => {
		conflicts.push(conflict);
		return "keep-both";
	});
	assert.equal(conflicts.length, 1);
	assert.equal(result.assets[0]?.relativePath, "to/report.tar 3.gz");
	assert.equal(await readFile(join(root, "to/report.tar.gz"), "utf8"), "old");
	assert.equal(await readFile(join(root, "to/report.tar 3.gz"), "utf8"), "new");
});

test("folders merge recursively and only matching files ask, preserving unrelated destination files", async (t) => {
	const { core, root } = await fixture(t, {
		"from/bundle/nested/same.md": "new", "from/bundle/unique.md": "unique",
		"to/bundle/nested/same.md": "old", "to/bundle/retained.md": "retained",
	});
	const conflicts: PasteConflict[] = [];
	const result = await core.pastePathsInto([join(root, "from/bundle")], "to", false, async (conflict) => {
		conflicts.push(conflict);
		return "replace";
	});
	assert.deepEqual(result.folders, ["to/bundle"]);
	assert.equal(conflicts.length, 1);
	assert.equal(conflicts[0]?.destinationPath, join(root, "to/bundle/nested/same.md"));
	assert.equal(await readFile(join(root, "to/bundle/nested/same.md"), "utf8"), "new");
	assert.equal(await readFile(join(root, "to/bundle/retained.md"), "utf8"), "retained");
	assert.equal(await readFile(join(root, "to/bundle/unique.md"), "utf8"), "unique");
	assert.equal(await readFile(join(root, "from/bundle/nested/same.md"), "utf8"), "new");
	assert.equal((await readdir(join(root, ".loom"))).some((name) => name.startsWith("paste-")), false);
});

test("moving a merged folder keeps asset identities and removes only the emptied source folders", async (t) => {
	const { core, root, initial } = await fixture(t, {
		"from/bundle/nested/same.md": "new", "from/bundle/unique.md": "unique", "to/bundle/nested/same.md": "old",
	});
	const original = initial.assets.find((asset) => asset.relativePath === "from/bundle/nested/same.md")!;
	const result = await core.pastePathsInto([join(root, "from/bundle")], "to", true, async () => "replace");
	assert.equal((await core.getAsset(original.assetId))?.relativePath, "to/bundle/nested/same.md");
	assert.equal((await core.getAsset(original.assetId))?.fileSystemId, original.fileSystemId);
	await assert.rejects(access(join(root, "from/bundle")));
	assert.equal((await core.getLibrarySnapshot()).folders.some((folder) => folder.startsWith("from/bundle")), false);
});

test("Cancel stops the batch and retains completed moves and unfinished source contents", async (t) => {
	const { core, root, initial } = await fixture(t, {
		"from/first.md": "first", "from/bundle/same.md": "new", "to/bundle/same.md": "old", "from/last.md": "last",
	});
	const result = await core.pastePathsInto([
		join(root, "from/first.md"), join(root, "from/bundle"), join(root, "from/last.md"),
	], "to", true, async () => "cancel");
	assert.equal(result.cancelled, true);
	assert.equal(result.assets[0]?.assetId, initial.assets.find((asset) => asset.relativePath === "from/first.md")?.assetId);
	assert.equal(await readFile(join(root, "to/first.md"), "utf8"), "first");
	assert.equal(await readFile(join(root, "from/bundle/same.md"), "utf8"), "new");
	assert.equal(await readFile(join(root, "to/bundle/same.md"), "utf8"), "old");
	assert.equal(await readFile(join(root, "from/last.md"), "utf8"), "last");
});

test("outside folders merge, and file-folder collisions support keeping both or replacing", async (t) => {
	const { core, root, directory } = await fixture(t, { "to/bundle/same.md": "old", "to/item": "file" });
	const outside = join(directory, "outside");
	await mkdir(join(outside, "bundle"), { recursive: true });
	await writeFile(join(outside, "bundle/same.md"), "new");
	const copied = await core.pastePathsInto([join(outside, "bundle")], "to", false, async () => "keep-both");
	assert.deepEqual(copied.folders, ["to/bundle"]);
	assert.equal(await readFile(join(root, "to/bundle/same 2.md"), "utf8"), "new");
	await mkdir(join(outside, "item"));
	await writeFile(join(outside, "item/content.md"), "folder");
	const both = await core.pastePathsInto([join(outside, "item")], "to", false, async () => "keep-both");
	assert.deepEqual(both.folders, ["to/item 2"]);
	await core.pastePathsInto([join(outside, "item")], "to", true, async () => "replace");
	assert.equal(await readFile(join(root, "to/item/content.md"), "utf8"), "folder");
	assert.equal((await core.getLibrarySnapshot()).assets.some((asset) => asset.relativePath === "to/item"), false);
	await assert.rejects(access(join(outside, "item")));
});

test("a destination modified during the prompt is preserved", async (t) => {
	const { core, root } = await fixture(t, { "from/note.md": "new", "to/note.md": "old" });
	await assert.rejects(core.pastePathsInto([join(root, "from/note.md")], "to", false, async () => {
		await writeFile(join(root, "to/note.md"), "changed while asking");
		return "replace";
	}), /changed/);
	assert.equal(await readFile(join(root, "to/note.md"), "utf8"), "changed while asking");
	assert.equal(await readFile(join(root, "from/note.md"), "utf8"), "new");
});

test("paste indexes its result and reconciles unrelated files created during a conflict prompt", { timeout: 10_000 }, async (t) => {
	const { core, root } = await fixture(t, { "from/note.md": "new", "to/note.md": "old" });
	const indexed = new Promise<void>((resolve) => {
		const unsubscribe = core.subscribeLibrary((change) => {
			if (change.type === "upsert" && change.asset.relativePath === "external.md") resolve();
		});
		t.after(unsubscribe);
	});
	const result = await core.pastePathsInto([join(root, "from/note.md")], "to", false, async () => {
		await writeFile(join(root, "external.md"), "created while asking");
		return "replace";
	});
	assert.equal(result.assets[0]?.relativePath, "to/note.md");
	assert.equal(await readFile(join(root, "to/note.md"), "utf8"), "new");
	await indexed;
});

test("copying during post-paste reconciliation discards the stale disk scan", { timeout: 10_000 }, async (t) => {
	const metadata = new SqliteMetadataStore();
	const { core, root, initial } = await fixture(t, { "note.md": "original" }, metadata);
	const scanning = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const reconciled = Promise.withResolvers<Asset[]>();
	const getVolume = metadata.getLibraryVolumeId.bind(metadata);
	const replaceAssets = metadata.replaceAssets.bind(metadata);
	t.mock.method(metadata, "getLibraryVolumeId", async () => {
		scanning.resolve();
		await release.promise;
		return getVolume();
	});
	t.mock.method(metadata, "replaceAssets", async (assets: Asset[]) => {
		await replaceAssets(assets);
		reconciled.resolve(assets);
	});
	const note = initial.assets[0]!;
	try {
		await core.pastePathsInto([join(root, note.relativePath)], "", false, unexpectedConflict);
		await scanning.promise;
		const copying = core.duplicateAsset(note.assetId);
		release.resolve();
		const copy = await copying;
		assert.equal(copy.relativePath, "note copy 2.md");
		assert.equal((await reconciled.promise).find((asset) => asset.relativePath === copy.relativePath)?.assetId, copy.assetId);
	} finally { release.resolve(); }
});

test("moving a merged folder retains ignored source contents", async (t) => {
	const { core, root } = await fixture(t, { "from/bundle/.DS_Store": "metadata", "from/bundle/note.md": "note", "to/bundle/old.md": "old" });
	const result = await core.pastePathsInto([join(root, "from/bundle")], "to", true, unexpectedConflict);
	assert.equal(await readFile(join(root, "from/bundle/.DS_Store"), "utf8"), "metadata");
	assert.equal(await readFile(join(root, "to/bundle/note.md"), "utf8"), "note");
});

test("a new destination appearing during a move restores the source instead of overwriting it", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "loom-paste-rollback-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const paths = new LibraryPaths(root);
	await mkdir(paths.loom);
	await mkdir(join(root, "from"));
	await mkdir(join(root, "to"));
	const source = join(root, "from/note.md");
	const destination = join(root, "to/note.md");
	await writeFile(source, "source");
	let checks = 0;
	await assert.rejects(pastePaths([source], join(root, "to"), {
		paths, move: true, resolveConflict: unexpectedConflict,
		checkActive: () => { if (++checks === 3) writeFileSync(destination, "arrived during transfer"); },
		onPlaced: async () => { throw new Error("Transfer must not complete"); },
		onMerged: async () => {},
	}), { code: "EEXIST" });
	assert.equal(await readFile(source, "utf8"), "source");
	assert.equal(await readFile(destination, "utf8"), "arrived during transfer");
	assert.deepEqual(await readdir(paths.loom), []);
});

test("switching libraries while asking about a conflict does not paste into either library", async (t) => {
	const { core, root, directory } = await fixture(t, { "from/note.md": "source", "to/note.md": "old" });
	const other = join(directory, "other-library");
	await mkdir(other);
	await writeFile(join(other, "untouched.md"), "untouched");
	await assert.rejects(core.pastePathsInto([join(root, "from/note.md")], "to", true, async () => {
		await core.openLibrary(other);
		return "replace";
	}), /library changed/);
	assert.equal(await readFile(join(root, "from/note.md"), "utf8"), "source");
	assert.equal(await readFile(join(root, "to/note.md"), "utf8"), "old");
	assert.deepEqual((await core.getLibrarySnapshot()).assets.map((asset) => asset.relativePath), ["untouched.md"]);
});

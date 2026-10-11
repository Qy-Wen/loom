import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalCore, LibraryPaths, SqliteMetadataStore, statVolumeId, type LibraryChange } from "../src/index.ts";

function waitForChange(
	core: LocalCore,
	predicate: (change: LibraryChange) => boolean,
): Promise<LibraryChange> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error("Timed out waiting for a library change"));
		}, 10_000);
		const unsubscribe = core.subscribeLibrary((change) => {
			if (!predicate(change)) return;
			clearTimeout(timeout);
			unsubscribe();
			resolve(change);
		});
	});
}

test("Library scans, ignores metadata, watches changes, and preserves identity on rename", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-library-test-"));
	const core = new LocalCore();
	let reopenedCore: LocalCore | undefined;

	try {
		await mkdir(join(root, ".loom"));
		await writeFile(join(root, ".loom", "ignored.txt"), "ignore me");
		await writeFile(join(root, ".DS_Store"), "Finder metadata");
		await mkdir(join(root, "notes"));
		await writeFile(join(root, "cover.jpg"), "image fixture");
		await writeFile(join(root, "notes", "brief.md"), "# Brief");

		const initial = await core.openLibrary(root);
		assert.deepEqual(initial.folders, ["notes"]);
		assert.deepEqual(initial.assets.map((asset) => asset.relativePath), ["cover.jpg", "notes/brief.md"]);

		const cover = initial.assets.find((asset) => asset.relativePath === "cover.jpg");
		assert.ok(cover);
		const renamed = await core.renameAsset(cover.assetId, "hero");
		assert.equal(renamed.assetId, cover.assetId);
		assert.equal(renamed.relativePath, "hero.jpg");

		const duplicate = await core.duplicateAsset(renamed.assetId);
		assert.equal(duplicate.relativePath, "hero copy.jpg");
		assert.notEqual(duplicate.assetId, renamed.assetId);

		const added = waitForChange(
			core,
			(change) => change.type === "upsert" && change.asset.relativePath === "clip.mp4",
		);
		await writeFile(join(root, "clip.mp4"), "video fixture");
		await added;

		assert.equal((await core.getLibrarySnapshot()).assets.length, 4);
		await access(join(root, ".loom", "metadata.db"));

		await core.close();
		await rm(join(root, "notes", "brief.md"));
		reopenedCore = new LocalCore();
		const reopened = await reopenedCore.openLibrary(root);
		const persistedHero = reopened.assets.find((asset) => asset.relativePath === "hero.jpg");
		assert.equal(persistedHero?.assetId, renamed.assetId);
		assert.equal(reopened.assets.length, 3);
		assert.equal(reopened.assets.some((asset) => asset.relativePath === "notes/brief.md"), false);
	} finally {
		await Promise.all([core.close(), reopenedCore?.close()]);
		await rm(root, { recursive: true, force: true });
	}
});

test("Library keeps the same asset id when a file is moved on disk", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-library-move-"));
	const core = new LocalCore();
	let reopenedCore: LocalCore | undefined;

	try {
		await writeFile(join(root, "cover.jpg"), "image fixture");
		const initial = await core.openLibrary(root);
		const cover = initial.assets.find((asset) => asset.relativePath === "cover.jpg");
		assert.ok(cover?.fileSystemId);

		const moved = waitForChange(
			core,
			(change) => change.type === "upsert" && change.asset.relativePath === "hero.jpg",
		);
		await rename(join(root, "cover.jpg"), join(root, "hero.jpg"));
		const change = await moved;
		assert.equal(change.type, "upsert");
		if (change.type === "upsert") {
			assert.equal(change.asset.assetId, cover.assetId);
			assert.equal(change.asset.fileSystemId, cover.fileSystemId);
		}

		await core.close();
		await mkdir(join(root, "archive"));
		await rename(join(root, "hero.jpg"), join(root, "archive", "hero.jpg"));
		reopenedCore = new LocalCore();
		const reopened = await reopenedCore.openLibrary(root);
		const archived = reopened.assets.find((asset) => asset.relativePath === "archive/hero.jpg");
		assert.equal(archived?.assetId, cover.assetId);
		assert.equal(reopened.assets.length, 1);
	} finally {
		await Promise.all([core.close(), reopenedCore?.close()]);
		await rm(root, { recursive: true, force: true });
	}
});

test("Library keeps asset ids and refreshes file system ids when the volume changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-library-volume-"));
	const core = new LocalCore();
	let reopenedCore: LocalCore | undefined;

	try {
		await writeFile(join(root, "cover.jpg"), "image fixture");
		const initial = await core.openLibrary(root);
		const cover = initial.assets.find((asset) => asset.relativePath === "cover.jpg");
		assert.ok(cover?.fileSystemId);
		await core.close();

		const store = new SqliteMetadataStore();
		await store.open(new LibraryPaths(root));
		await store.setLibraryVolumeId("relocated-volume");
		const stored = await store.getAsset(cover.assetId);
		assert.ok(stored);
		await store.upsertAsset({ ...stored, fileSystemId: "9:9" });
		await store.close();

		reopenedCore = new LocalCore();
		const reopened = await reopenedCore.openLibrary(root);
		const again = reopened.assets.find((asset) => asset.relativePath === "cover.jpg");
		assert.equal(again?.assetId, cover.assetId);
		assert.equal(again?.fileSystemId, cover.fileSystemId);
		assert.notEqual(again?.fileSystemId, "9:9");

		const check = new SqliteMetadataStore();
		await check.open(new LibraryPaths(root));
		assert.equal(await check.getLibraryVolumeId(), await statVolumeId(root));
		await check.close();
	} finally {
		await Promise.all([core.close(), reopenedCore?.close()]);
		await rm(root, { recursive: true, force: true });
	}
});

test("Library keeps a moved file's id when the old path is reused while closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-library-replace-"));
	const core = new LocalCore();
	let reopenedCore: LocalCore | undefined;

	try {
		await writeFile(join(root, "cover.jpg"), "original");
		const initial = await core.openLibrary(root);
		const cover = initial.assets.find((asset) => asset.relativePath === "cover.jpg");
		assert.ok(cover);
		await core.close();

		await mkdir(join(root, "z-archive"));
		await rename(join(root, "cover.jpg"), join(root, "z-archive", "cover.jpg"));
		await writeFile(join(root, "cover.jpg"), "replacement");

		reopenedCore = new LocalCore();
		const reopened = await reopenedCore.openLibrary(root);
		const archived = reopened.assets.find((asset) => asset.relativePath === "z-archive/cover.jpg");
		const replaced = reopened.assets.find((asset) => asset.relativePath === "cover.jpg");
		assert.equal(archived?.assetId, cover.assetId);
		assert.ok(replaced);
		assert.notEqual(replaced.assetId, cover.assetId);
		assert.equal(reopened.assets.length, 2);
	} finally {
		await Promise.all([core.close(), reopenedCore?.close()]);
		await rm(root, { recursive: true, force: true });
	}
});

test("Library keeps both asset ids when two files are swapped while closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-library-swap-"));
	const core = new LocalCore();
	let reopenedCore: LocalCore | undefined;

	try {
		await writeFile(join(root, "a.jpg"), "aaa");
		await writeFile(join(root, "b.jpg"), "bbb");
		const initial = await core.openLibrary(root);
		const a = initial.assets.find((asset) => asset.relativePath === "a.jpg");
		const b = initial.assets.find((asset) => asset.relativePath === "b.jpg");
		assert.ok(a && b);
		await core.close();

		await rename(join(root, "a.jpg"), join(root, "_tmp.jpg"));
		await rename(join(root, "b.jpg"), join(root, "a.jpg"));
		await rename(join(root, "_tmp.jpg"), join(root, "b.jpg"));

		reopenedCore = new LocalCore();
		const reopened = await reopenedCore.openLibrary(root);
		assert.equal(reopened.assets.find((asset) => asset.relativePath === "a.jpg")?.assetId, b.assetId);
		assert.equal(reopened.assets.find((asset) => asset.relativePath === "b.jpg")?.assetId, a.assetId);
	} finally {
		await Promise.all([core.close(), reopenedCore?.close()]);
		await rm(root, { recursive: true, force: true });
	}
});

test("Library creates, renames, copies, and pastes folders and files", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-library-ops-"));
	const core = new LocalCore();

	try {
		await mkdir(join(root, "notes"));
		await writeFile(join(root, "cover.jpg"), "image fixture");
		await writeFile(join(root, "notes", "brief.md"), "# Brief");

		const initial = await core.openLibrary(root);
		const cover = initial.assets.find((asset) => asset.relativePath === "cover.jpg");
		const brief = initial.assets.find((asset) => asset.relativePath === "notes/brief.md");
		assert.ok(cover && brief);

		assert.equal(await core.createFolder(""), "New Folder");
		assert.equal(await core.createFolder(""), "New Folder 2");
		assert.equal(await core.createFolder("notes"), "notes/New Folder");

		assert.equal(await core.renameFolder("notes", "briefs"), "briefs");
		const renamed = await core.getLibrarySnapshot();
		assert.deepEqual(
			renamed.folders.filter((folder) => folder === "briefs" || folder.startsWith("briefs/")),
			["briefs", "briefs/New Folder"],
		);
		assert.equal(renamed.assets.find((asset) => asset.relativePath === "briefs/brief.md")?.assetId, brief.assetId);

		const pasted = await core.copyAssetsInto([cover.assetId], "briefs");
		assert.equal(pasted[0].relativePath, "briefs/cover.jpg");
		assert.notEqual(pasted[0].assetId, cover.assetId);

		const copiedFolder = await core.copyFolderInto("briefs", "");
		assert.equal(copiedFolder, "briefs copy");
		const afterCopy = await core.getLibrarySnapshot();
		assert.ok(afterCopy.assets.some((asset) => asset.relativePath === "briefs copy/brief.md"));
		assert.ok(afterCopy.assets.some((asset) => asset.relativePath === "briefs copy/cover.jpg"));

		await assert.rejects(() => core.copyFolderInto("briefs", "briefs"), /into itself/);
		await assert.rejects(() => core.renameFolder("briefs", "briefs copy"), /already exists/);

		const markdown = await core.createMarkdownFile("");
		assert.equal(markdown.relativePath, "Untitled.md");
		assert.equal(markdown.type, "text");
		assert.equal((await core.createMarkdownFile("")).relativePath, "Untitled 2.md");
		assert.equal((await core.createMarkdownFile("briefs")).relativePath, "briefs/Untitled.md");

		const movedCover = await core.moveAssetsInto([cover.assetId], "New Folder");
		assert.equal(movedCover[0].assetId, cover.assetId);
		assert.equal(movedCover[0].relativePath, "New Folder/cover.jpg");
		assert.equal((await core.getLibrarySnapshot()).assets.some((asset) => asset.relativePath === "cover.jpg"), false);

		const nested = await core.moveFolderInto("briefs/New Folder", "New Folder 2");
		assert.equal(nested, "New Folder 2/New Folder");
		await assert.rejects(() => core.moveFolderInto("New Folder 2", "New Folder 2/New Folder"), /into itself/);
		const movedBriefs = await core.moveFolderInto("briefs", "New Folder 2");
		assert.equal(movedBriefs, "New Folder 2/briefs");
		const afterMove = await core.getLibrarySnapshot();
		assert.equal(afterMove.assets.find((asset) => asset.relativePath === "New Folder/cover.jpg")?.assetId, cover.assetId);
		assert.equal(afterMove.assets.find((asset) => asset.relativePath === "New Folder 2/briefs/brief.md")?.assetId, brief.assetId);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Library copies an outside file into Inbox and reuses a file already in the library", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-import-"));
	const outside = await mkdtemp(join(tmpdir(), "loom-import-src-"));
	const core = new LocalCore();
	try {
		await mkdir(join(root, ".loom"));
		await writeFile(join(root, "cover.jpg"), "already in library");
		await writeFile(join(outside, "shot.png"), "external image");
		const opened = await core.openLibrary(root);
		const cover = opened.assets.find((asset) => asset.relativePath === "cover.jpg");
		assert.ok(cover);

		const [imported, reused] = await core.importExternalFiles([
			join(outside, "shot.png"),
			join(root, "cover.jpg"),
		]);
		assert.equal(imported.relativePath, "Inbox/shot.png");
		assert.equal(imported.type, "image");
		assert.equal(reused.assetId, cover.assetId);
		assert.equal(reused.relativePath, "cover.jpg");

		const again = await core.importExternalFiles([join(outside, "shot.png")]);
		assert.equal(again[0].relativePath, "Inbox/shot 2.png");
		assert.notEqual(again[0].assetId, imported.assetId);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("Library places outside files and folders into a chosen folder", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-place-"));
	const outside = await mkdtemp(join(tmpdir(), "loom-place-src-"));
	const core = new LocalCore();
	try {
		await mkdir(join(root, "briefs"));
		await writeFile(join(root, "cover.jpg"), "cover");
		await mkdir(join(outside, "album"));
		await writeFile(join(outside, "album", "shot.png"), "shot");
		await writeFile(join(outside, "loose.txt"), "loose");
		const opened = await core.openLibrary(root);
		const cover = opened.assets.find((asset) => asset.relativePath === "cover.jpg");
		assert.ok(cover);

		const copied = await core.placePathsInto([
			join(outside, "album"),
			join(outside, "album", "shot.png"),
			join(outside, "loose.txt"),
		], "briefs", false);
		assert.deepEqual(copied.folders, ["briefs/album"]);
		assert.equal(copied.assets.length, 1);
		assert.equal(copied.assets[0].relativePath, "briefs/loose.txt");
		const afterCopy = await core.getLibrarySnapshot();
		assert.ok(afterCopy.assets.some((asset) => asset.relativePath === "briefs/album/shot.png"));
		assert.equal(afterCopy.assets.some((asset) => asset.relativePath === "briefs/shot.png"), false);
		assert.equal(await readFile(join(outside, "loose.txt"), "utf8"), "loose");

		const again = await core.placePathsInto([join(outside, "loose.txt")], "briefs", false);
		assert.equal(again.assets[0].relativePath, "briefs/loose copy.txt");

		await writeFile(join(outside, ".DS_Store"), "meta");
		await assert.rejects(() => core.placePathsInto([join(outside, ".DS_Store")], "briefs", false), /cannot be imported/);
		await assert.rejects(() => core.placePathsInto([join(root, "briefs")], "briefs", false), /into itself/);

		const moved = await core.placePathsInto([join(outside, "album")], "", true);
		assert.deepEqual(moved.folders, ["album"]);
		await assert.rejects(() => access(join(outside, "album")));
		assert.ok((await core.getLibrarySnapshot()).assets.some((asset) => asset.relativePath === "album/shot.png"));

		const movedCover = await core.placePathsInto([join(root, "cover.jpg")], "briefs", true);
		assert.equal(movedCover.assets[0].assetId, cover.assetId);
		assert.equal(movedCover.assets[0].relativePath, "briefs/cover.jpg");
		await assert.rejects(() => access(join(root, "cover.jpg")));
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("Library creates .agents/memory and does not index .agents", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-memory-dir-"));
	const core = new LocalCore();
	try {
		await mkdir(join(root, ".agents", "skills", "voice"), { recursive: true });
		await writeFile(join(root, ".agents", "skills", "voice", "SKILL.md"), "skill");
		await mkdir(join(root, ".agents", "memory"), { recursive: true });
		await writeFile(join(root, ".agents", "memory", "MEMORY.md"), "user prefers concise titles");
		const opened = await core.openLibrary(root);
		await access(join(root, ".agents", "memory"));
		assert.equal(opened.folders.includes(".agents"), false);
		assert.equal(opened.folders.includes(".agents/memory"), false);
		assert.equal(opened.assets.some((asset) => asset.relativePath.includes("MEMORY.md")), false);
		assert.equal(opened.assets.some((asset) => asset.relativePath.includes("SKILL.md")), false);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Library favorites follow the asset id and drop when the file is gone", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-favorites-"));
	const core = new LocalCore();
	let reopened: LocalCore | undefined;
	try {
		await writeFile(join(root, "a.jpg"), "a");
		await writeFile(join(root, "b.jpg"), "b");
		const opened = await core.openLibrary(root);
		assert.deepEqual(opened.favoriteAssetIds, []);
		const first = opened.assets.find((asset) => asset.relativePath === "a.jpg");
		const second = opened.assets.find((asset) => asset.relativePath === "b.jpg");
		assert.ok(first && second);

		await core.setFavorite(first.assetId, true);
		await core.setFavorite(second.assetId, true);
		assert.deepEqual((await core.getLibrarySnapshot()).favoriteAssetIds, [second.assetId, first.assetId]);

		await core.setFavorite(first.assetId, true);
		assert.deepEqual((await core.getLibrarySnapshot()).favoriteAssetIds, [first.assetId, second.assetId]);

		const renamed = await core.renameAsset(second.assetId, "renamed");
		assert.equal(renamed.assetId, second.assetId);
		assert.equal(renamed.relativePath, "renamed.jpg");
		assert.deepEqual((await core.getLibrarySnapshot()).favoriteAssetIds, [first.assetId, second.assetId]);

		await core.setFavorite(second.assetId, false);
		assert.deepEqual((await core.getLibrarySnapshot()).favoriteAssetIds, [first.assetId]);
		await assert.rejects(() => core.setFavorite("missing", true), /Asset not found/);

		await core.close();
		await rm(join(root, "a.jpg"));
		reopened = new LocalCore();
		const again = await reopened.openLibrary(root);
		assert.deepEqual(again.favoriteAssetIds, []);
		assert.equal(again.assets.some((asset) => asset.assetId === first.assetId), false);
		assert.equal(again.assets.find((asset) => asset.relativePath === "renamed.jpg")?.assetId, second.assetId);
	} finally {
		await Promise.all([core.close(), reopened?.close()]);
		await rm(root, { recursive: true, force: true });
	}
});

test("Library tags are shared by name and stay with the asset id", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-tags-"));
	const core = new LocalCore();
	let reopened: LocalCore | undefined;
	try {
		await writeFile(join(root, "a.jpg"), "a");
		await writeFile(join(root, "b.jpg"), "b");
		const opened = await core.openLibrary(root);
		const first = opened.assets.find((asset) => asset.relativePath === "a.jpg");
		const second = opened.assets.find((asset) => asset.relativePath === "b.jpg");
		assert.ok(first && second);
		assert.deepEqual(opened.tags, []);

		await core.addAssetTag(first.assetId, "  Hero  ");
		await core.addAssetTag(first.assetId, "cover");
		await core.addAssetTag(second.assetId, "hero");
		await assert.rejects(() => core.addAssetTag(first.assetId, "   "), /cannot be empty/);

		const tagged = await core.getLibrarySnapshot();
		assert.deepEqual(tagged.tags.map((tag) => tag.name), ["cover", "Hero"]);
		const hero = tagged.tags.find((tag) => tag.name === "Hero");
		const cover = tagged.tags.find((tag) => tag.name === "cover");
		assert.ok(hero && cover);
		assert.deepEqual(
			tagged.assetTags.filter((row) => row.assetId === first.assetId).map((row) => row.tagId),
			[hero.tagId, cover.tagId],
		);
		assert.deepEqual(
			tagged.assetTags.filter((row) => row.assetId === second.assetId).map((row) => row.tagId),
			[hero.tagId],
		);

		await core.removeAssetTag(second.assetId, hero.tagId);
		assert.equal((await core.getLibrarySnapshot()).tags.some((tag) => tag.tagId === hero.tagId), true);
		await core.removeAssetTag(first.assetId, hero.tagId);
		const afterHero = await core.getLibrarySnapshot();
		assert.equal(afterHero.tags.some((tag) => tag.tagId === hero.tagId), false);
		assert.deepEqual(afterHero.assetTags.map((row) => row.tagId), [cover.tagId]);

		const renamed = await core.renameAsset(first.assetId, "renamed");
		assert.equal(renamed.assetId, first.assetId);
		assert.deepEqual((await core.getLibrarySnapshot()).assetTags.map((row) => row.assetId), [first.assetId]);

		await core.close();
		await rm(join(root, "renamed.jpg"));
		reopened = new LocalCore();
		const again = await reopened.openLibrary(root);
		assert.deepEqual(again.tags, []);
		assert.deepEqual(again.assetTags, []);
	} finally {
		await Promise.all([core.close(), reopened?.close()]);
		await rm(root, { recursive: true, force: true });
	}
});

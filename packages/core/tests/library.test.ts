import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
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

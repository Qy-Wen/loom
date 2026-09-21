import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalCore, type LibrarySnapshot } from "../src/index.ts";

async function waitUntil(
	core: LocalCore,
	predicate: (snapshot: LibrarySnapshot) => boolean,
	label: string,
): Promise<LibrarySnapshot> {
	const immediate = await core.getLibrarySnapshot();
	if (predicate(immediate)) return immediate;

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			void core.getLibrarySnapshot().then((snapshot) => {
				reject(new Error(`${label}: ${JSON.stringify(snapshot.assets.map((asset) => ({
					id: asset.assetId,
					path: asset.relativePath,
				})))}`));
			});
		}, 10_000);
		const unsubscribe = core.subscribeLibrary(() => {
			void core.getLibrarySnapshot().then((snapshot) => {
				if (!predicate(snapshot)) return;
				clearTimeout(timeout);
				unsubscribe();
				resolve(snapshot);
			});
		});
	});
}

test("Library keeps asset id when a folder is renamed while open", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-live-folder-"));
	const core = new LocalCore();
	try {
		await mkdir(join(root, "shots"));
		await writeFile(join(root, "shots", "a.jpg"), "a");
		const initial = await core.openLibrary(root);
		const id = initial.assets[0]?.assetId;
		assert.ok(id);

		await rename(join(root, "shots"), join(root, "stills"));
		const snap = await waitUntil(
			core,
			(snapshot) => snapshot.assets.some((asset) => asset.relativePath === "stills/a.jpg"),
			"folder rename",
		);
		assert.equal(snap.assets.find((asset) => asset.relativePath === "stills/a.jpg")?.assetId, id);
		assert.equal(snap.assets.length, 1);
		assert.deepEqual(snap.folders, ["stills"]);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Library keeps both ids when two files are swapped while open", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-live-swap-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "a.jpg"), "aaa");
		await writeFile(join(root, "b.jpg"), "bbb");
		const initial = await core.openLibrary(root);
		const a = initial.assets.find((asset) => asset.relativePath === "a.jpg");
		const b = initial.assets.find((asset) => asset.relativePath === "b.jpg");
		assert.ok(a && b);

		await rename(join(root, "a.jpg"), join(root, "_tmp.jpg"));
		await rename(join(root, "b.jpg"), join(root, "a.jpg"));
		await rename(join(root, "_tmp.jpg"), join(root, "b.jpg"));

		const snap = await waitUntil(
			core,
			(snapshot) =>
				snapshot.assets.find((asset) => asset.relativePath === "a.jpg")?.assetId === b.assetId &&
				snapshot.assets.find((asset) => asset.relativePath === "b.jpg")?.assetId === a.assetId,
			"swap files",
		);
		assert.equal(snap.assets.length, 2);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Library keeps a moved file's id when the old path is reused while open", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-live-replace-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "cover.jpg"), "original");
		const initial = await core.openLibrary(root);
		const cover = initial.assets[0];
		assert.ok(cover);

		await mkdir(join(root, "z-archive"));
		await rename(join(root, "cover.jpg"), join(root, "z-archive", "cover.jpg"));
		await writeFile(join(root, "cover.jpg"), "replacement");

		const snap = await waitUntil(
			core,
			(snapshot) =>
				snapshot.assets.some((asset) => asset.relativePath === "z-archive/cover.jpg") &&
				snapshot.assets.some((asset) => asset.relativePath === "cover.jpg"),
			"move then replace",
		);
		assert.equal(snap.assets.find((asset) => asset.relativePath === "z-archive/cover.jpg")?.assetId, cover.assetId);
		assert.notEqual(snap.assets.find((asset) => asset.relativePath === "cover.jpg")?.assetId, cover.assetId);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

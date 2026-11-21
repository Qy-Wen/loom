import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LocalCore, tryResolveMediaBinaries } from "../src/index.ts";
import { buildThumbnailArgs } from "../src/media/operations.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "media");

test("thumbnail args crop to a square WebP and seek only when asked", () => {
	const plain = buildThumbnailArgs("in.png", "out.webp", 256);
	assert.ok(!plain.includes("-ss"));
	assert.ok(plain.includes("libwebp"));
	assert.ok(plain.some((arg) => arg.endsWith("crop=256:256")));
	assert.deepEqual(buildThumbnailArgs("in.mp4", "out.webp", 256, 0.1).slice(0, 3), ["-y", "-ss", "0.1"]);
});

test("thumbnails are cached under .loom, reused, shared between concurrent requests, and refreshed on change", async (t) => {
	if (!tryResolveMediaBinaries()) {
		t.skip("bundled ffmpeg is not installed; run pnpm vendor:ffmpeg");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "loom-thumb-"));
	const core = new LocalCore();
	try {
		await copyFile(join(FIXTURES, "still.png"), join(root, "still.png"));
		await copyFile(join(FIXTURES, "clip.mp4"), join(root, "clip.mp4"));
		await writeFile(join(root, "notes.md"), "# notes");
		await writeFile(join(root, "broken.png"), "not an image");
		const snapshot = await core.openLibrary(root);
		const byName = (name: string) => snapshot.assets.find((asset) => asset.filename === name)!;

		const image = (await core.getThumbnailPath(byName("still.png").assetId))!;
		assert.ok(image.startsWith(join(root, ".loom", "thumbnails")));
		assert.equal((await readFile(image)).subarray(8, 12).toString(), "WEBP");

		const videoAsset = byName("clip.mp4");
		const video = await core.getThumbnailPath(videoAsset.assetId);
		assert.ok(video && (await stat(video)).size > 0);
		const poster = await core.getThumbnailPath(videoAsset.assetId, undefined, "poster");
		assert.ok(poster && (await stat(poster)).size > 0);
		assert.notEqual(poster, video);
		assert.equal(await core.getThumbnailPath(videoAsset.assetId, undefined, "poster"), poster);

		assert.equal(await core.getThumbnailPath(byName("notes.md").assetId), undefined);
		assert.equal(await core.getThumbnailPath(byName("broken.png").assetId), undefined);
		assert.equal(await core.getThumbnailPath("missing"), undefined);

		// A second request is served from disk, not regenerated.
		const first = (await stat(image)).ino;
		assert.equal(await core.getThumbnailPath(byName("still.png").assetId), image);
		assert.equal((await stat(image)).ino, first);

		// Concurrent requests share one job.
		const [a, b] = await Promise.all([
			core.getThumbnailPath(videoAsset.assetId),
			core.getThumbnailPath(videoAsset.assetId),
		]);
		assert.equal(a, b);

		// Reopening reconciles the new source timestamp before checking both cached previews.
		const later = new Date(videoAsset.modifiedAt + 5_000);
		await utimes(join(root, videoAsset.filename), later, later);
		const reopened = await core.openLibrary(root);
		const refreshed = reopened.assets.find((asset) => asset.assetId === videoAsset.assetId);
		assert.ok(refreshed && refreshed.modifiedAt > videoAsset.modifiedAt);
		for (const variant of ["square", "poster"] as const) {
			const path = await core.getThumbnailPath(refreshed.assetId, undefined, variant);
			assert.ok(path);
			assert.ok(Math.abs((await stat(path)).mtimeMs - refreshed.modifiedAt) < 2);
		}
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
});

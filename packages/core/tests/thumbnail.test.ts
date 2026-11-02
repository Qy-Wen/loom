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

		const video = (await core.getThumbnailPath(byName("clip.mp4").assetId))!;
		assert.ok(video && (await stat(video)).size > 0);

		assert.equal(await core.getThumbnailPath(byName("notes.md").assetId), undefined);
		assert.equal(await core.getThumbnailPath(byName("broken.png").assetId), undefined);
		assert.equal(await core.getThumbnailPath("missing"), undefined);

		// A second request is served from disk, not regenerated.
		const first = (await stat(image)).ino;
		assert.equal(await core.getThumbnailPath(byName("still.png").assetId), image);
		assert.equal((await stat(image)).ino, first);

		// Concurrent requests share one job.
		const [a, b] = await Promise.all([
			core.getThumbnailPath(byName("clip.mp4").assetId),
			core.getThumbnailPath(byName("clip.mp4").assetId),
		]);
		assert.equal(a, b);

		// A changed file gets a new thumbnail.
		await copyFile(join(FIXTURES, "still.png"), join(root, "still.png"));
		const later = new Date(Date.now() + 5_000);
		await utimes(join(root, "still.png"), later, later);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const refreshed = await core.getAsset(byName("still.png").assetId);
		assert.ok(refreshed && refreshed.modifiedAt > byName("still.png").modifiedAt);
		const again = (await core.getThumbnailPath(refreshed.assetId))!;
		assert.ok(again);
		assert.ok(Math.abs((await stat(again)).mtimeMs - refreshed.modifiedAt) < 2);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
});

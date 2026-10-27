import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LocalCore, tryResolveMediaBinaries } from "../src/index.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "media");
const VIDEO = "clip.mp4";
const IMAGE = "still.png";

test("MediaService processes committed video and image fixtures", async (t) => {
	if (!tryResolveMediaBinaries()) {
		t.skip("bundled ffmpeg is not installed; run pnpm vendor:ffmpeg");
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "loom-media-real-"));
	const core = new LocalCore();
	try {
		await copyFile(join(FIXTURES, VIDEO), join(root, VIDEO));
		await copyFile(join(FIXTURES, IMAGE), join(root, IMAGE));
		const snapshot = await core.openLibrary(root);
		const video = snapshot.assets.find((asset) => asset.relativePath === VIDEO);
		const image = snapshot.assets.find((asset) => asset.relativePath === IMAGE);
		assert.ok(video);
		assert.ok(image);

		const videoInfo = await core.getMediaInfo(VIDEO);
		assert.equal(videoInfo.kind, "media_info");
		assert.equal(videoInfo.path, VIDEO);
		assert.equal(videoInfo.videoCodec, "h264");
		assert.equal(videoInfo.audioCodec, "aac");
		assert.equal(videoInfo.width, 480);
		assert.equal(videoInfo.height, 360);
		assert.ok((videoInfo.duration ?? 0) > 1.5);
		assert.ok((videoInfo.duration ?? 0) < 2.5);
		assertNoAbsoluteLeak(videoInfo, root, FIXTURES);

		const imageInfo = await core.getMediaInfo(IMAGE);
		assert.equal(imageInfo.videoCodec, "png");
		assert.equal(imageInfo.width, 480);
		assert.equal(imageInfo.height, 249);
		assertNoAbsoluteLeak(imageInfo, root, FIXTURES);

		const frame = await core.runFfmpeg({
			args: ["-ss", "1", "-i", VIDEO, "-frames:v", "1", "outputs/frame.jpg"],
		});
		assert.equal(frame.output, "outputs/frame.jpg");
		await assertOutputFile(root, "outputs/frame.jpg");
		const videoAfterFrame = await core.inspectAsset(video.assetId);
		assert.deepEqual(videoAfterFrame.links, []);
		const frameInfo = await core.getMediaInfo("outputs/frame.jpg");
		assert.equal(frameInfo.width, videoInfo.width);
		assert.equal(frameInfo.height, videoInfo.height);
		assertNoAbsoluteLeak(frame, root, FIXTURES);

		await core.runFfmpeg({ args: ["-ss", "0.5", "-i", VIDEO, "-t", "1", "outputs/clip.mp4"] });
		await assertOutputFile(root, "outputs/clip.mp4");
		const clipInfo = await core.getMediaInfo("outputs/clip.mp4");
		assert.ok((clipInfo.duration ?? 0) >= 0.8);
		assert.ok((clipInfo.duration ?? 0) <= 1.5);
		assert.equal(clipInfo.width, videoInfo.width);
		assert.equal(clipInfo.height, videoInfo.height);

		const scale = "scale='min(320,iw)':'min(320,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
		await core.runFfmpeg({ args: ["-i", VIDEO, "-vf", scale, "outputs/small.mp4"] });
		const resizedInfo = await core.getMediaInfo("outputs/small.mp4");
		assert.ok((resizedInfo.width ?? Infinity) <= 320);
		assert.ok((resizedInfo.height ?? Infinity) <= 320);
		assert.ok((resizedInfo.width ?? 0) >= 2);

		await core.runFfmpeg({ args: ["-i", VIDEO, "-vf", "crop=320:240:16:16", "outputs/crop.mp4"] });
		const croppedInfo = await core.getMediaInfo("outputs/crop.mp4");
		assert.equal(croppedInfo.width, 320);
		assert.equal(croppedInfo.height, 240);

		await core.runFfmpeg({ args: ["-i", IMAGE, "outputs/still.jpg"] });
		const jpgInfo = await core.getMediaInfo("outputs/still.jpg");
		assert.equal(jpgInfo.width, imageInfo.width);
		assert.equal(jpgInfo.height, imageInfo.height);

		await core.runFfmpeg({ args: ["-i", "outputs/clip.mp4", "outputs/clip.mp3"] });
		const audioInfo = await core.getMediaInfo("outputs/clip.mp3");
		assert.equal(audioInfo.audioCodec, "mp3");
		assert.equal(audioInfo.videoCodec, undefined);

		const raw = await core.runFfmpeg({
			args: ["-y", "-i", "outputs/clip.mp4", "-vn", "-acodec", "pcm_s16le", "outputs/clip.wav"],
		});
		assert.equal(raw.output, "outputs/clip.wav");
		await assertOutputFile(root, "outputs/clip.wav");
		assertNoAbsoluteLeak(raw, root, FIXTURES);

		// Media output is indexed; provenance edges are explicit, not inferred by these operations.
		const clipView = await waitForIndexedAsset(core, "outputs/clip.mp4");
		assert.ok(clipView);
		const clipDetail = await core.inspectAsset(clipView.assetId);
		assert.deepEqual(clipDetail.links, []);
		assert.deepEqual((await core.inspectAsset(video.assetId)).links, []);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

async function waitForIndexedAsset(core: LocalCore, relativePath: string) {
	const deadline = Date.now() + 5000;
	for (;;) {
		const asset = (await core.getLibrarySnapshot()).assets.find((item) => item.relativePath === relativePath);
		if (asset) return asset;
		if (Date.now() >= deadline) throw new Error(`Watcher did not index ${relativePath}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function assertNoAbsoluteLeak(value: unknown, ...roots: string[]): void {
	const text = JSON.stringify(value);
	for (const root of roots) {
		assert.equal(text.includes(root), false, `result leaked ${root}`);
	}
}

async function assertOutputFile(root: string, relativePath: string): Promise<void> {
	const info = await stat(join(root, relativePath));
	assert.ok(info.size > 0, `${relativePath} is empty`);
}

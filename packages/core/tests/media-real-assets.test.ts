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

		const frame = await core.extractFrame({
			path: VIDEO,
			timeSeconds: 1,
			output: "outputs/frame.jpg",
		});
		assert.equal(frame.output, "outputs/frame.jpg");
		await assertOutputFile(root, "outputs/frame.jpg");
		const videoAfterFrame = await core.inspectAsset(video.assetId);
		assert.deepEqual(videoAfterFrame.links, []);
		const frameInfo = await core.getMediaInfo("outputs/frame.jpg");
		assert.equal(frameInfo.width, videoInfo.width);
		assert.equal(frameInfo.height, videoInfo.height);
		assertNoAbsoluteLeak(frame, root, FIXTURES);

		const clip = await core.extractClip({
			path: VIDEO,
			startSeconds: 0.5,
			durationSeconds: 1,
			output: "outputs/clip.mp4",
		});
		assert.equal(clip.output, "outputs/clip.mp4");
		await assertOutputFile(root, "outputs/clip.mp4");
		const clipInfo = await core.getMediaInfo("outputs/clip.mp4");
		assert.ok((clipInfo.duration ?? 0) >= 0.8);
		assert.ok((clipInfo.duration ?? 0) <= 1.5);
		assert.equal(clipInfo.width, videoInfo.width);
		assert.equal(clipInfo.height, videoInfo.height);

		const resized = await core.resizeVideo({
			path: VIDEO,
			maxEdge: 320,
			output: "outputs/small.mp4",
		});
		assert.equal(resized.output, "outputs/small.mp4");
		const resizedInfo = await core.getMediaInfo("outputs/small.mp4");
		assert.ok((resizedInfo.width ?? Infinity) <= 320);
		assert.ok((resizedInfo.height ?? Infinity) <= 320);
		assert.ok((resizedInfo.width ?? 0) >= 2);

		const cropped = await core.cropVideo({
			path: VIDEO,
			x: 16,
			y: 16,
			width: 320,
			height: 240,
			output: "outputs/crop.mp4",
		});
		assert.equal(cropped.output, "outputs/crop.mp4");
		const croppedInfo = await core.getMediaInfo("outputs/crop.mp4");
		assert.equal(croppedInfo.width, 320);
		assert.equal(croppedInfo.height, 240);

		const jpg = await core.convertFormat({
			path: IMAGE,
			format: "jpg",
			output: "outputs/still.jpg",
		});
		assert.equal(jpg.output, "outputs/still.jpg");
		const jpgInfo = await core.getMediaInfo("outputs/still.jpg");
		assert.equal(jpgInfo.width, imageInfo.width);
		assert.equal(jpgInfo.height, imageInfo.height);

		const audio = await core.convertFormat({
			path: "outputs/clip.mp4",
			format: "mp3",
			output: "outputs/clip.mp3",
		});
		assert.equal(audio.output, "outputs/clip.mp3");
		const audioInfo = await core.getMediaInfo("outputs/clip.mp3");
		assert.equal(audioInfo.audioCodec, "mp3");
		assert.equal(audioInfo.videoCodec, undefined);

		const raw = await core.runFfmpeg({
			args: ["-y", "-i", "outputs/clip.mp4", "-vn", "-acodec", "pcm_s16le", "outputs/clip.wav"],
		});
		assert.equal(raw.output, "outputs/clip.wav");
		await assertOutputFile(root, "outputs/clip.wav");
		assertNoAbsoluteLeak(raw, root, FIXTURES);

		const clipView = (await core.inspectAsset(video.assetId)).generated.find(
			(item) => item.relativePath === "outputs/clip.mp4",
		);
		assert.ok(clipView);
		const clipDetail = await core.inspectAsset(clipView.assetId);
		assert.ok(clipDetail.generated.some((item) => item.relativePath === "outputs/clip.mp3"));
		assert.equal(clipDetail.generated.some((item) => item.relativePath === "outputs/clip.wav"), false);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

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

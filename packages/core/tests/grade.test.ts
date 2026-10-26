import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalCore, tryResolveMediaBinaries } from "../src/index.ts";
import {
	FULL_IMAGE_CROP,
	IDENTITY_IMAGE_GRADE,
	adjustCrop,
	buildGradeImageArgs,
	buildGradeVideoArgs,
	buildGradeVideoFrameArgs,
	buildImageGradeFilter,
	escapeFfmpegFilterPath,
	flipCrop,
	gradeSiblingRelative,
	gradeVideoAudioArgs,
	gradeVideoSiblingRelative,
	isGradeableVideo,
	isGradeVideoExportPath,
	isNeutralImageGrade,
	normalizeImageGrade,
	rotateCrop,
} from "../src/grade/index.ts";

test("an unchanged grade produces no filtergraph", () => {
	assert.equal(buildImageGradeFilter(IDENTITY_IMAGE_GRADE), null);
	assert.equal(isNeutralImageGrade(normalizeImageGrade({})), true);
	assert.equal(isNeutralImageGrade(normalizeImageGrade({ exposure: 0, temperature: 6500 })), true);
});

test("grade filters use FFmpeg parameters in a fixed order", () => {
	const filter = buildImageGradeFilter(normalizeImageGrade({
		exposure: 0.5,
		contrast: 1.2,
		saturation: 0.8,
		vibrance: -0.25,
		temperature: 4500,
		black: 0.05,
		white: 0.95,
		curves: { rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }] },
	}), "C:\\Looks\\my lut.cube");
	assert.equal(filter, [
		"exposure=exposure=0.5",
		"eq=contrast=1.2:saturation=0.8",
		"vibrance=intensity=-0.25",
		"colortemperature=temperature=4500",
		"colorlevels=rimin=0.05:gimin=0.05:bimin=0.05:rimax=0.95:gimax=0.95:bimax=0.95",
		"curves=master='0/0 0.5/0.6 1/1'",
		"lut3d=file='C\\:/Looks/my lut.cube'",
	].join(","));
});

test("rotation, mirror, and crop run before color", () => {
	const filter = buildImageGradeFilter(normalizeImageGrade({
		rotation: 1,
		flipH: true,
		flipV: true,
		crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
		exposure: 1,
	}));
	assert.equal(filter, [
		"transpose=1",
		"hflip",
		"vflip",
		"crop=trunc(iw*0.5):trunc(ih*0.4):trunc(iw*0.1):trunc(ih*0.2)",
		"exposure=exposure=1",
	].join(","));
	assert.equal(buildImageGradeFilter(normalizeImageGrade({ rotation: 2 })), "hflip,vflip");
	assert.equal(buildImageGradeFilter(normalizeImageGrade({ rotation: 3, flipH: true })), "transpose=2,hflip");
	assert.equal(isNeutralImageGrade(normalizeImageGrade({ crop: FULL_IMAGE_CROP })), true);
	assert.equal(isNeutralImageGrade(normalizeImageGrade({ rotation: 1 })), false);
});

test("crop stays on the same pixels when the frame turns or mirrors", () => {
	const crop = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
	assert.deepEqual(rotateCrop(crop, 1), { x: 0.4, y: 0.1, w: 0.4, h: 0.3 });
	assert.deepEqual(rotateCrop(crop, -1), rotateCrop(crop, 3));
	assert.deepEqual(rotateCrop(FULL_IMAGE_CROP, 1), FULL_IMAGE_CROP);
	assert.deepEqual(flipCrop(crop, "h"), { x: 0.6, y: 0.2, w: 0.3, h: 0.4 });
	assert.deepEqual(flipCrop(crop, "v"), { x: 0.1, y: 0.4, w: 0.3, h: 0.4 });
	assert.deepEqual(adjustCrop(FULL_IMAGE_CROP, "w", 0.2, 0), { x: 0.2, y: 0, w: 0.8, h: 1 });
	assert.deepEqual(adjustCrop({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, "move", 0.1, -0.1), { x: 0.3, y: 0.1, w: 0.4, h: 0.4 });
	assert.deepEqual(adjustCrop({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, "move", -1, 0), { x: 0, y: 0.1, w: 0.4, h: 0.4 });
});

test("hue, lightness, and brightness map onto huesaturation and eq", () => {
	assert.equal(
		buildImageGradeFilter(normalizeImageGrade({ hue: 25, lightness: -0.3, brightness: 0.2 })),
		"eq=brightness=0.2,huesaturation=hue=25:intensity=-0.3",
	);
});

test("filter paths escape quotes and colons", () => {
	assert.equal(escapeFfmpegFilterPath("/tmp/a'b:c.cube"), "/tmp/a\\'b\\:c.cube");
});

test("proxy args scale before the grade and keep a single frame", () => {
	const args = buildGradeImageArgs("/in.png", "/out.jpg", "exposure=exposure=1", true);
	assert.deepEqual(args.slice(0, 4), ["-y", "-i", "/in.png", "-vf"]);
	assert.match(args[4], /^scale='min\(1280,iw\)':'min\(1280,ih\)':force_original_aspect_ratio=decrease,exposure=exposure=1$/);
	assert.ok(args.includes("-frames:v"));
	assert.equal(args.at(-1), "/out.jpg");
});

test("a saved grade is named beside the source", () => {
	assert.equal(gradeSiblingRelative("photos/still.png"), "photos/still_grade.png");
	assert.equal(gradeSiblingRelative("still.jpeg"), "still_grade.jpg");
	assert.equal(gradeSiblingRelative("anim.gif"), "anim_grade.png");
	assert.equal(gradeSiblingRelative("scan.tif"), "scan_grade.tiff");
	assert.equal(gradeSiblingRelative("photos/still.png", 2), "photos/still_grade 2.png");
});

test("normalizeImageGrade clamps to filter ranges and keeps curve endpoints", () => {
	const grade = normalizeImageGrade({
		exposure: 9,
		contrast: -4,
		temperature: 20,
		black: 0.8,
		white: 0.2,
		curves: { r: [{ x: 0.4, y: 2 }, { x: 0.4, y: 0.2 }] },
	});
	assert.equal(grade.exposure, 3);
	assert.equal(grade.contrast, 0);
	assert.equal(grade.temperature, 1000);
	assert.ok(grade.black <= grade.white);
	assert.equal(grade.curves.r[0].x, 0);
	assert.equal(grade.curves.r.at(-1)?.x, 1);
	assert.equal(grade.curves.r.filter((point) => point.x === 0.4).length, 1);
	assert.equal(grade.rotation, 0);
	assert.equal(grade.flipH, false);
	assert.deepEqual(grade.crop, { x: 0, y: 0, w: 1, h: 1 });
	const tight = normalizeImageGrade({ rotation: 9, flipH: "yes", crop: { x: 0.2, y: -1, w: 2, h: 0.3 } });
	assert.equal(tight.rotation, 0);
	assert.equal(tight.flipH, false);
	assert.deepEqual(tight.crop, { x: 0.2, y: 0, w: 0.8, h: 0.3 });
});

test("gradeImage writes a new still, indexes it, and stores the recipe", async (t) => {
	if (!tryResolveMediaBinaries()) {
		t.skip("bundled ffmpeg is not installed; run pnpm vendor:ffmpeg");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "loom-grade-"));
	const core = new LocalCore();
	try {
		const { copyFile } = await import("node:fs/promises");
		const { dirname } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "media", "still.png");
		await copyFile(fixture, join(root, "still.png"));
		await core.openLibrary(root);
		await assert.rejects(
			core.gradeImage({ path: "still.png", grade: {} }),
			/does not change/,
		);

		const graded = await core.gradeImage({
			path: "still.png",
			grade: { exposure: 1, temperature: 4500 },
		});
		assert.equal(graded.output, "outputs/still_grade.png");
		assert.ok(graded.assetId);
		assert.ok(graded.sourceAssetId);
		const output = await readFile(join(root, "outputs", "still_grade.png"));
		assert.ok(output.byteLength > 32);

		const snapshot = await core.getLibrarySnapshot();
		assert.ok(snapshot.assets.some((asset) => asset.assetId === graded.assetId));
		const stored = await core.getImageGrade(graded.assetId);
		assert.equal(stored?.grade.exposure, 1);
		assert.equal(stored?.grade.temperature, 4500);
		assert.equal(stored?.sourceAssetId, graded.sourceAssetId);

		const preview = await core.previewImageGrade(graded.sourceAssetId!, { exposure: 1 });
		assert.ok(preview && preview.length > 100);
		assert.equal(await core.previewImageGrade(graded.sourceAssetId!, {}), null);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("gradeImage rotates before it crops", async (t) => {
	if (!tryResolveMediaBinaries()) {
		t.skip("bundled ffmpeg is not installed; run pnpm vendor:ffmpeg");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "loom-grade-geometry-"));
	const core = new LocalCore();
	try {
		const { copyFile } = await import("node:fs/promises");
		const { dirname } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "media", "still.png");
		await copyFile(fixture, join(root, "still.png"));
		await core.openLibrary(root);
		const source = pngSize(await readFile(fixture));
		const graded = await core.gradeImage({
			path: "still.png",
			grade: { rotation: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } },
		});
		const output = pngSize(await readFile(join(root, graded.output)));
		assert.equal(output.w, Math.trunc(source.h * 0.5));
		assert.equal(output.h, source.w);
		const stored = await core.getImageGrade(graded.assetId);
		assert.equal(stored?.grade.rotation, 1);
		assert.deepEqual(stored?.grade.crop, { x: 0, y: 0, w: 0.5, h: 1 });
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("video preview seeks one scaled frame and export reencodes with copied audio", () => {
	assert.equal(isGradeableVideo("clip.mp4"), true);
	assert.equal(isGradeableVideo("still.png"), false);
	assert.equal(gradeVideoSiblingRelative("clips/clip.mov"), "clips/clip_grade.mp4");
	assert.equal(gradeVideoSiblingRelative("clip.webm", 2), "clip_grade 2.mp4");
	assert.equal(isGradeVideoExportPath("out.mkv"), true);
	assert.equal(isGradeVideoExportPath("out.webm"), false);
	assert.deepEqual(gradeVideoAudioArgs("aac"), ["-c:a", "copy"]);
	assert.deepEqual(gradeVideoAudioArgs(undefined), ["-c:a", "copy"]);
	assert.deepEqual(gradeVideoAudioArgs("opus"), ["-c:a", "aac", "-b:a", "192k"]);

	const frame = buildGradeVideoFrameArgs("/in.mp4", "/frame.jpg", 1.25);
	assert.deepEqual(frame.slice(0, 6), ["-y", "-ss", "1.25", "-i", "/in.mp4", "-an"]);
	assert.ok(frame.includes("-frames:v"));
	assert.match(frame.join(" "), /scale='min\(1280,iw\)'/);

	const copy = buildGradeVideoArgs("/in.mp4", "/out.mp4", "exposure=exposure=1", "aac");
	assert.ok(copy.includes("exposure=exposure=1,pad=ceil(iw/2)*2:ceil(ih/2)*2"));
	assert.ok(copy.includes("libx264"));
	assert.deepEqual(copy.slice(copy.indexOf("-c:a"), copy.indexOf("-c:a") + 2), ["-c:a", "copy"]);
	assert.ok(copy.includes("+faststart"));
	const encoded = buildGradeVideoArgs("/in.webm", "/out.mkv", "exposure=exposure=1", "opus");
	assert.equal(encoded.includes("+faststart"), false);
	assert.deepEqual(encoded.slice(encoded.indexOf("-c:a"), encoded.indexOf("-c:a") + 4), ["-c:a", "aac", "-b:a", "192k"]);
});

test("gradeVideo writes a new movie from the current recipe", async (t) => {
	if (!tryResolveMediaBinaries()) {
		t.skip("bundled ffmpeg is not installed; run pnpm vendor:ffmpeg");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "loom-grade-video-"));
	const core = new LocalCore();
	try {
		const { copyFile } = await import("node:fs/promises");
		const { dirname } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "media", "clip.mp4");
		await copyFile(fixture, join(root, "clip.mp4"));
		await core.openLibrary(root);
		const source = (await core.getLibrarySnapshot()).assets.find((asset) => asset.filename === "clip.mp4");
		assert.ok(source);
		await assert.rejects(core.gradeVideo({ path: "clip.mp4", grade: {} }), /does not change/);
		assert.equal(await core.previewVideoGrade(source.assetId, 0, {}), null);

		const plain = await core.previewVideoGrade(source.assetId, 0, {}, undefined, true);
		assert.ok(plain && plain.startsWith("/9j/"));
		const gradedPreview = await core.previewVideoGrade(source.assetId, 0, { exposure: 1 });
		assert.ok(gradedPreview && gradedPreview.startsWith("/9j/"));
		assert.notEqual(gradedPreview, plain);

		const graded = await core.gradeVideo({
			path: "clip.mp4",
			grade: { exposure: 0.5 },
			beside: true,
		});
		assert.equal(graded.output, "clip_grade.mp4");
		const output = await readFile(join(root, "clip_grade.mp4"));
		assert.ok(output.byteLength > 32);
		const stored = await core.getImageGrade(graded.assetId);
		assert.equal(stored?.grade.exposure, 0.5);
		assert.equal(stored?.sourceAssetId, graded.sourceAssetId);
		const info = await core.getVideoGradeInfo(source.assetId);
		assert.ok((info.duration ?? 0) > 0);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

function pngSize(bytes: Buffer): { w: number; h: number } {
	assert.equal(bytes.toString("ascii", 1, 4), "PNG");
	return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

test("grade scratch files live outside the library and are removed when the library closes", async (t) => {
	if (!tryResolveMediaBinaries()) {
		t.skip("bundled ffmpeg is not installed; run pnpm vendor:ffmpeg");
		return;
	}
	const { copyFile, readdir, stat, writeFile } = await import("node:fs/promises");
	const { dirname } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const root = await mkdtemp(join(tmpdir(), "loom-grade-scratch-"));
	const outside = await mkdtemp(join(tmpdir(), "loom-lut-source-"));
	const core = new LocalCore();
	const scratchDirs = async () => (await readdir(tmpdir())).filter((name) => name.startsWith("loom-grade-") && !name.startsWith("loom-grade-scratch-"));
	try {
		const before = new Set(await scratchDirs());
		await copyFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "media", "still.png"), join(root, "still.png"));
		const snapshot = await core.openLibrary(root);
		const source = snapshot.assets.find((asset) => asset.relativePath === "still.png")!;

		const preview = await core.previewImageGrade(source.assetId, { exposure: 1 });
		assert.ok(preview && preview.length > 100);
		const created = (await scratchDirs()).filter((name) => !before.has(name));
		assert.equal(created.length, 1);
		await assert.rejects(stat(join(root, ".loom", "cache")), { code: "ENOENT" });

		await writeFile(join(outside, "look.cube"), "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
		const lut = await core.importGradeLut(join(outside, "look.cube"));
		assert.equal(lut.path, ".loom/grades/luts/look.cube");
		const graded = await core.gradeImage({ path: "still.png", grade: { exposure: 1 }, lut: lut.path });
		assert.equal((await stat(join(root, ".loom", "grades", "records", `${graded.assetId}.json`))).isFile(), true);
		assert.equal((await core.getImageGrade(graded.assetId))?.lut, lut.path);

		await core.close();
		assert.deepEqual((await scratchDirs()).filter((name) => !before.has(name)), []);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

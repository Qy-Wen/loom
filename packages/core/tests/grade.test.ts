import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
	IDENTITY_IMAGE_GRADE,
	LocalCore,
	buildGradeImageArgs,
	buildImageGradeFilter,
	escapeFfmpegFilterPath,
	gradeSiblingRelative,
	isNeutralImageGrade,
	normalizeImageGrade,
	tryResolveMediaBinaries,
} from "../src/index.ts";

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

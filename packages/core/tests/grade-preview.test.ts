import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildGradeImageArgs, buildGradePreviewArgs, buildImageGradeFilter } from "../src/grade/filters.ts";
import { normalizeImageGrade } from "../src/grade/types.ts";
import { tryResolveMediaBinaries } from "../src/media/binaries.ts";
import { GradePreview } from "../src/media/grade-preview.ts";
import { MediaOutputLimitError, runMediaProcessBuffer, type RunMediaProcessOptions } from "../src/media/run.ts";
import { releaseProcessSandbox, setProcessSandboxEnabled, setProcessSandboxRoot } from "../src/sandbox/process-sandbox.ts";

const colorInfo = "[Parsed_showinfo_0 @ 0x1] fmt:yuvj420p\n[Parsed_showinfo_0 @ 0x1] color_range:pc color_space:bt470bg color_primaries:unknown color_trc:unknown";
const jpeg = Buffer.from([255, 216, 255, 217]);

test("preview cache reuses decoded frames, invalidates changed files, and clears on close", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-preview-cache-"));
	const path = join(root, "source.png");
	await writeFile(path, "first");
	const calls: RunMediaProcessOptions[] = [];
	const preview = new GradePreview(async (options) => {
		calls.push(options);
		return options.input ? { stdout: jpeg, stderr: "" } : { stdout: Buffer.from("frame"), stderr: colorInfo };
	}, () => true);
	try {
		await preview.render(path, "exposure=exposure=1", root);
		await preview.render(path, "eq=brightness=0.1", root);
		assert.equal(calls.filter((c) => !c.input).length, 1);
		await writeFile(path, "changed source");
		await preview.render(path, "eq=contrast=1.1", root);
		assert.equal(calls.filter((c) => !c.input).length, 2);
		preview.clear();
		await preview.render(path, null, root);
		assert.equal(calls.filter((c) => !c.input).length, 3);
		const renders = calls.length;
		assert.deepEqual(await preview.render(path, null, root), jpeg);
		assert.equal(calls.length, renders, "Before preview should reuse its JPEG without spawning FFmpeg");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("oversized decoded frames fall back without retrying the cache or losing video seek", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-preview-fallback-"));
	const path = join(root, "clip.mp4");
	await writeFile(path, "clip");
	let decodes = 0;
	const preview = new GradePreview(async (options) => {
		if (options.args.includes("rawvideo")) { decodes++; throw new MediaOutputLimitError(); }
		assert.equal(options.input, undefined);
		assert.deepEqual(options.args.slice(0, 2), ["-ss", "1.25"]);
		return { stdout: jpeg, stderr: "" };
	}, () => true);
	try {
		await preview.render(path, null, root, undefined, 1.25);
		await preview.render(path, "exposure=exposure=1", root, undefined, 1.25);
		assert.equal(decodes, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cache evicts least recently used frames to keep decoded memory bounded", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-preview-lru-"));
	const path = join(root, "clip.mp4");
	await writeFile(path, "clip");
	const large = Buffer.alloc(50 * 1024 * 1024);
	let decodes = 0;
	const preview = new GradePreview(async (options) => {
		if (options.input) return { stdout: jpeg, stderr: "" };
		decodes++;
		return { stdout: large, stderr: colorInfo };
	}, () => true);
	try {
		await preview.render(path, null, root, undefined, 0);
		await preview.render(path, null, root, undefined, 1);
		await preview.render(path, null, root, undefined, 1);
		assert.equal(decodes, 2);
		await preview.render(path, null, root, undefined, 0);
		assert.equal(decodes, 3);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a new request recovers when a shared decode was aborted", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-preview-abort-"));
	const path = join(root, "source.png");
	await writeFile(path, "image");
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	let decodes = 0;
	const preview = new GradePreview(async (options) => {
		if (options.input) return { stdout: jpeg, stderr: "" };
		if (++decodes === 1) {
			started();
			await new Promise((_, reject) => options.signal!.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true }));
		}
		return { stdout: Buffer.from("frame"), stderr: colorInfo };
	}, () => true);
	try {
		const controller = new AbortController();
		const old = preview.render(path, null, root, controller.signal);
		const rejected = assert.rejects(old, { name: "AbortError" });
		await ready;
		const next = preview.render(path, null, root);
		// Let the second request finish stat() and join the existing decode.
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		await rejected;
		assert.deepEqual(await next, jpeg);
		assert.equal(decodes, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cached image previews keep legacy pixels and ICC profiles across formats and grade changes", async (t) => {
	if (!tryResolveMediaBinaries()) { t.skip("bundled ffmpeg is not installed"); return; }
	const root = await mkdtemp(join(tmpdir(), "loom-preview-pixels-"));
	setProcessSandboxRoot(root);
	// Exercise pixel conversion here; sandbox transport is covered by grade.test
	// and the Electron test without wrapping every reference/decode subprocess.
	await setProcessSandboxEnabled(false);
	const preview = new GradePreview();
	try {
		const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "media", "still.png");
		await copyFile(fixture, join(root, "source.png"));
		// An ICC-carrying JPEG exercises the profile lost by the raw NUT container.
		const sourceJpeg = join(root, "source.jpg");
		await runMediaProcessBuffer({ program: "ffmpeg", args: ["-y", "-i", join(root, "source.png"), "-frames:v", "1", "-pix_fmt", "yuvj420p", sourceJpeg], cwd: root });
		const profile = await readFile(join(dirname(fixture), "srgb.icc"));
		const payload = Buffer.concat([Buffer.from("ICC_PROFILE\0"), Buffer.from([1, 1]), profile]);
		const header = Buffer.alloc(4);
		header.writeUInt16BE(0xffe2, 0);
		header.writeUInt16BE(payload.length + 2, 2);
		const image = await readFile(sourceJpeg);
		await writeFile(sourceJpeg, Buffer.concat([image.subarray(0, 2), header, payload, image.subarray(2)]));
		for (const [name, format] of [["source16.png", "rgb48be"], ["source.tiff", "rgb48le"], ["source.bmp", "bgr24"], ["source.webp", "yuv420p"]]) {
			await runMediaProcessBuffer({ program: "ffmpeg", args: ["-y", "-i", join(root, "source.png"), "-frames:v", "1", "-pix_fmt", format, join(root, name)], cwd: root });
		}
		await copyFile(join(dirname(fixture), "animated.gif"), join(root, "source.gif"));
		for (const name of ["source.png", "source.jpg", "source16.png", "source.tiff", "source.bmp", "source.webp", "source.gif"]) {
			const path = join(root, name);
			for (const grade of [{}, { brightness: 0.12 }, { exposure: 1 }, { exposure: 0.4, contrast: 1.1, saturation: 1.15, vibrance: 0.2, temperature: 5500 }, { rotation: 1, crop: { x: 0.1, y: 0.2, w: 0.7, h: 0.6 } }]) {
				const filter = buildImageGradeFilter(normalizeImageGrade(grade));
				const reference = join(root, "reference.jpg");
				await runMediaProcessBuffer({ program: "ffmpeg", args: buildGradeImageArgs(path, reference, filter, true), cwd: root });
				const old = await readFile(reference);
				const actual = await preview.render(path, filter, root);
				const decode = async (input: Buffer) => (await runMediaProcessBuffer({ program: "ffmpeg", args: ["-i", "pipe:0", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], input, cwd: root })).stdout;
				assert.deepEqual(await decode(actual), await decode(old), `${name}: ${JSON.stringify(grade)}`);
				const icc = (bytes: Buffer) => {
					const offset = bytes.indexOf(Buffer.from("ICC_PROFILE\0"));
					return offset < 0 ? null : bytes.subarray(offset, offset + bytes.readUInt16BE(offset - 2) - 2);
				};
				if (name.endsWith("jpg")) assert.ok(icc(old));
				assert.deepEqual(icc(actual), icc(old));
			}
		}
	} finally {
		await releaseProcessSandbox(root);
		await setProcessSandboxEnabled(true);
		await rm(root, { recursive: true, force: true });
	}
});

test("video previews retain the requested frame while reusing its decoded pixels", async (t) => {
	if (!tryResolveMediaBinaries()) { t.skip("bundled ffmpeg is not installed"); return; }
	const root = await mkdtemp(join(tmpdir(), "loom-preview-seek-"));
	setProcessSandboxRoot(root);
	await setProcessSandboxEnabled(false);
	let decodes = 0;
	const preview = new GradePreview(async (options) => {
		if (options.args.includes("rawvideo")) decodes++;
		return runMediaProcessBuffer(options);
	});
	try {
		const source = join(root, "clip.mp4");
		await copyFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "media", "clip.mp4"), source);
		for (const time of [0.25, 1.25]) {
			for (const grade of [{}, { exposure: 0.5 }]) {
				const filter = buildImageGradeFilter(normalizeImageGrade(grade));
				const actual = await preview.render(source, filter, root, undefined, time);
				const { stdout: reference } = await runMediaProcessBuffer({
					program: "ffmpeg", args: ["-ss", String(time), ...buildGradePreviewArgs(source, filter)], cwd: root,
				});
				const decode = async (input: Buffer) => (await runMediaProcessBuffer({ program: "ffmpeg", args: ["-i", "pipe:0", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], input, cwd: root })).stdout;
				assert.deepEqual(await decode(actual), await decode(reference));
			}
		}
		assert.equal(decodes, 2);
	} finally {
		await releaseProcessSandbox(root);
		await setProcessSandboxEnabled(true);
		await rm(root, { recursive: true, force: true });
	}
});

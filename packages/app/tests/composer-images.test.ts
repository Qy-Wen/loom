import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { COMPOSER_IMAGE_MAX_BYTES } from "@loom/agent/composer-image";
import { stageComposerInput, takeComposerImages } from "../src/main/composer/composer-images.ts";
import { takeComposerAssets } from "../src/main/composer/composer-assets.ts";
import { importComposerFiles } from "../src/main/composer/composer-import.ts";
import { composerFileInputs } from "../src/renderer/chat/composer-files.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const chip = { assetId: "image-1", path: "old.png", assetType: "image" };
const image = { filename: "image.png", mimeType: "image/png" as const, data: png.toString("base64") };

test("staging uses live asset IDs for bytes, deduplicates chips, and consumes images once", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-composer-images-"));
	try {
		const path = join(root, "renamed.PNG");
		await writeFile(path, png);
		await stageComposerInput("image-turn", [chip, chip, { assetId: "text", path: "a.md", assetType: "text" }], async (id) => {
			assert.equal(id, chip.assetId);
			return path;
		});
		assert.deepEqual(await takeComposerImages("image-turn"), [{ ...image, filename: "renamed.PNG" }]);
		assert.equal((await takeComposerAssets("image-turn")).length, 2);
		assert.deepEqual(await takeComposerImages("image-turn"), []);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("restaging removed chips clears image bytes and isolates conversations", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-composer-clear-"));
	try {
		const path = join(root, "image.png");
		await writeFile(path, png);
		await stageComposerInput("removed", [chip], async () => path);
		await stageComposerInput("other", [chip], async () => path);
		await stageComposerInput("removed", [], async () => { throw new Error("no image read expected"); });
		assert.deepEqual(await takeComposerImages("removed"), []);
		assert.deepEqual(await takeComposerAssets("removed"), []);
		assert.equal((await takeComposerImages("other")).length, 1);
		await takeComposerAssets("other");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("missing, invalid, oversized, and excess images fail before staging references", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-composer-limits-"));
	try {
		const path = join(root, "image.png");
		await assert.rejects(stageComposerInput("limits", [chip], async () => undefined), /no longer in the library/);
		await writeFile(path, "not an image");
		await assert.rejects(stageComposerInput("limits", [chip], async () => path), /JPEG, PNG, GIF, or WebP/);
		await writeFile(path, Buffer.alloc(COMPOSER_IMAGE_MAX_BYTES + 1));
		await assert.rejects(stageComposerInput("limits", [chip], async () => path), /8 MB/);
		await writeFile(path, png);
		await assert.rejects(stageComposerInput("limits", Array.from({ length: 5 }, (_, i) => ({ ...chip, assetId: `image-${i}` })), async () => path), /up to 4/);
		assert.deepEqual(await takeComposerAssets("limits"), []);
		assert.deepEqual(await takeComposerImages("limits"), []);
		await stageComposerInput("format", [chip], async () => join(root, "image.bmp"));
		assert.deepEqual(await takeComposerImages("format"), []);
		assert.equal((await takeComposerAssets("format")).length, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("clipboard bytes and native disk paths are imported together without losing either", async () => {
	const screenshot = new File([png], "screenshot.png", { type: "image/png" });
	const disk = new File(["text"], "notes.md", { type: "text/markdown" });
	const payload = await composerFileInputs([disk, screenshot], (file) => file === disk ? "native-file.md" : "");
	assert.deepEqual(payload, { paths: ["native-file.md"], images: [{ ...image, filename: "screenshot.png" }] });
	let temporaryPath = "";
	const imported = await importComposerFiles(payload.paths, payload.images, async (paths) => {
		assert.equal(paths[0], "native-file.md");
		temporaryPath = paths[1]!;
		assert.deepEqual(await readFile(temporaryPath), png);
		assert.match(temporaryPath, /\.png$/);
		return ["disk-asset", "screenshot-asset"];
	});
	assert.deepEqual(imported, ["disk-asset", "screenshot-asset"]);
	await assert.rejects(stat(temporaryPath), { code: "ENOENT" });
});

test("clipboard imports validate before writes, sanitize portable names, and clean up failures", async () => {
	await assert.rejects(composerFileInputs([new File(["no"], "bad.png")], () => ""), /JPEG, PNG, GIF, or WebP/);
	await assert.rejects(importComposerFiles([], [{ ...image, mimeType: "image/jpeg" }], async () => { throw new Error("must not import"); }), /JPEG, PNG, GIF, or WebP/);
	let temporaryPath = "";
	await assert.rejects(importComposerFiles([], [{ ...image, filename: "..\\CON:<x>?" }], async (paths) => {
		temporaryPath = paths[0]!;
		assert.match(temporaryPath, /0-CON__x__\.png$/);
		throw new Error("import failed");
	}), /import failed/);
	await assert.rejects(stat(temporaryPath), { code: "ENOENT" });
});

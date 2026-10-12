import assert from "node:assert/strict";
import { test } from "node:test";
import { parseComposerImageInputs, sniffComposerImage } from "../src/composer-image.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const image = { filename: "picture.png", mimeType: "image/png", data: png.toString("base64") };

test("composer images preserve validated model input and normalize filenames", () => {
	assert.deepEqual(parseComposerImageInputs([image]), [image]);
	assert.deepEqual(parseComposerImageInputs([{ ...image, filename: " \u0000 " }]), [{ ...image, filename: "image.png" }]);
	assert.deepEqual(parseComposerImageInputs([]), []);
});

test("composer images reject invalid data and mismatched formats", () => {
	assert.equal(sniffComposerImage(new Uint8Array([0, 1, 2, 3])), undefined);
	assert.throws(() => parseComposerImageInputs([{ ...image, data: Buffer.from([1, 2, 3, 4]).toString("base64") }]), /JPEG, PNG, GIF, or WebP/);
	assert.throws(() => parseComposerImageInputs([{ ...image, mimeType: "image/jpeg" }]), /JPEG, PNG, GIF, or WebP/);
	assert.throws(() => parseComposerImageInputs([{ ...image, data: "!invalid!" }]), /Image data is invalid/);
});

test("composer images enforce count and per-image size limits", () => {
	assert.equal(parseComposerImageInputs(Array(4).fill(image)).length, 4);
	assert.throws(() => parseComposerImageInputs(Array(5).fill(image)), /up to 4 images/);
	const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
	png.copy(oversized);
	assert.throws(() => parseComposerImageInputs([{ ...image, data: oversized.toString("base64") }]), /8 MB or smaller/);
});

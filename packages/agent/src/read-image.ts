/**
 * Prepare a `read` image for the model.
 * JPEG, PNG, GIF, and WebP stay in their format when they already fit.
 * Anything else Photon can decode, including BMP, is converted to PNG.
 * Images wider or taller than 2000px, or whose base64 payload exceeds 4.5MB, are scaled down.
 */
import { createRequire } from "node:module";
import type { ReadImageProcessor, ReadImageProcessorResult } from "#vendor/pi-agent";

const require = createRequire(import.meta.url);

const MAX_WIDTH = 2000;
const MAX_HEIGHT = 2000;
/** Base64 payload kept under the common 5MB inline-image limit. */
const MAX_BYTES = 4.5 * 1024 * 1024;

const INLINE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type PhotonImage = {
	free(): void;
	get_width(): number;
	get_height(): number;
	get_bytes(): Uint8Array;
	get_bytes_jpeg(quality: number): Uint8Array;
	get_raw_pixels(): Uint8Array;
};

type Photon = {
	PhotonImage: {
		new (pixels: Uint8Array, width: number, height: number): PhotonImage;
		new_from_byteslice(bytes: Uint8Array): PhotonImage;
	};
	resize(image: PhotonImage, width: number, height: number, filter: number): PhotonImage;
	SamplingFilter: { Lanczos3: number };
	fliph(image: PhotonImage): void;
	flipv(image: PhotonImage): void;
};

export type ReadImageOptions = {
	autoResizeImages?: boolean;
	maxWidth?: number;
	maxHeight?: number;
	maxBytes?: number;
};

let photonModule: Photon | null | undefined;

function loadPhoton(): Photon | null {
	if (photonModule !== undefined) return photonModule;
	try {
		photonModule = require("@silvia-odwyer/photon-node") as Photon;
	} catch {
		photonModule = null;
	}
	return photonModule;
}

function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function base64Size(byteLength: number): number {
	return Math.ceil(byteLength / 3) * 4;
}

export async function processReadImageBytes(
	bytes: Uint8Array,
	mimeType: string,
	options: ReadImageOptions = {},
): Promise<ReadImageProcessorResult> {
	const photon = loadPhoton();
	if (!photon) {
		if (INLINE_MIME.has(mimeType)) {
			return { ok: true, data: base64(bytes), mimeType, hints: [] };
		}
		return { ok: false, message: "[Image omitted: could not be converted to a supported inline image format.]" };
	}

	const normalized = normalize(photon, bytes, mimeType);
	if (!normalized) {
		return { ok: false, message: "[Image omitted: could not be converted to a supported inline image format.]" };
	}

	const hints: string[] = [];
	if (normalized.convertedFrom) hints.push(`[Image converted from ${normalized.convertedFrom} to ${normalized.mimeType}.]`);

	if (options.autoResizeImages === false) {
		return { ok: true, data: base64(normalized.bytes), mimeType: normalized.mimeType, hints };
	}

	const resized = resize(photon, normalized.bytes, normalized.mimeType, bytes, options);
	if (!resized) {
		if (INLINE_MIME.has(normalized.mimeType) && !normalized.convertedFrom) {
			return { ok: true, data: base64(normalized.bytes), mimeType: normalized.mimeType, hints };
		}
		return { ok: false, message: "[Image omitted: could not be resized below the inline image size limit.]" };
	}
	if (resized.note) hints.push(resized.note);
	return { ok: true, data: resized.data, mimeType: resized.mimeType, hints };
}

/** Harness `read` hook. `autoResizeImages` defaults to true at the call site. */
export const processReadImage: ReadImageProcessor = (bytes, mimeType, options) => {
	return processReadImageBytes(bytes, mimeType, { autoResizeImages: options.autoResizeImages });
};

function normalize(photon: Photon, bytes: Uint8Array, mimeType: string): { bytes: Uint8Array; mimeType: string; convertedFrom?: string } | null {
	if (INLINE_MIME.has(mimeType)) return { bytes, mimeType };
	const png = encodePng(photon, bytes);
	if (!png) return null;
	return { bytes: png, mimeType: "image/png", convertedFrom: mimeType };
}

function encodePng(photon: Photon, bytes: Uint8Array): Uint8Array | null {
	let image: PhotonImage | undefined;
	try {
		image = photon.PhotonImage.new_from_byteslice(bytes);
		return new Uint8Array(image.get_bytes());
	} catch {
		return null;
	} finally {
		image?.free();
	}
}

function resize(
	photon: Photon,
	inputBytes: Uint8Array,
	mimeType: string,
	orientationBytes: Uint8Array,
	options: ReadImageOptions,
): { data: string; mimeType: string; note?: string } | null {
	const maxWidth = options.maxWidth ?? MAX_WIDTH;
	const maxHeight = options.maxHeight ?? MAX_HEIGHT;
	const maxBytes = options.maxBytes ?? MAX_BYTES;
	let image: PhotonImage | undefined;
	try {
		const raw = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, raw, orientationBytes);
		if (image !== raw) raw.free();
		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		if (originalWidth <= maxWidth && originalHeight <= maxHeight && base64Size(inputBytes.byteLength) < maxBytes) {
			return { data: base64(inputBytes), mimeType };
		}

		let width = originalWidth;
		let height = originalHeight;
		if (width > maxWidth) {
			height = Math.max(1, Math.round((height * maxWidth) / width));
			width = maxWidth;
		}
		if (height > maxHeight) {
			width = Math.max(1, Math.round((width * maxHeight) / height));
			height = maxHeight;
		}

		const qualities = [80, 85, 70, 55, 40];
		while (true) {
			const fitted = encodeFitted(photon, image, width, height, qualities, maxBytes);
			if (fitted) {
				const scale = originalWidth / width;
				const note = `[Image: original ${originalWidth}x${originalHeight}, displayed at ${width}x${height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
				return { ...fitted, note };
			}
			if (width === 1 && height === 1) return null;
			const nextWidth = width === 1 ? 1 : Math.max(1, Math.floor(width * 0.75));
			const nextHeight = height === 1 ? 1 : Math.max(1, Math.floor(height * 0.75));
			if (nextWidth === width && nextHeight === height) return null;
			width = nextWidth;
			height = nextHeight;
		}
	} catch {
		return null;
	} finally {
		image?.free();
	}
}

function encodeFitted(
	photon: Photon,
	image: PhotonImage,
	width: number,
	height: number,
	qualities: number[],
	maxBytes: number,
): { data: string; mimeType: string } | null {
	const resized = photon.resize(image, width, height, photon.SamplingFilter.Lanczos3);
	try {
		const candidates = [
			{ bytes: resized.get_bytes(), mimeType: "image/png" },
			...qualities.map((quality) => ({ bytes: resized.get_bytes_jpeg(quality), mimeType: "image/jpeg" })),
		];
		let best: { data: string; mimeType: string } | undefined;
		for (const candidate of candidates) {
			const data = base64(candidate.bytes);
			if (data.length >= maxBytes) continue;
			if (!best || data.length < best.data.length) best = { data, mimeType: candidate.mimeType };
		}
		return best ?? null;
	} finally {
		resized.free();
	}
}

function applyExifOrientation(photon: Photon, image: PhotonImage, originalBytes: Uint8Array): PhotonImage {
	switch (exifOrientation(originalBytes)) {
		case 2:
			photon.fliph(image);
			return image;
		case 3:
			photon.fliph(image);
			photon.flipv(image);
			return image;
		case 4:
			photon.flipv(image);
			return image;
		case 5: {
			const rotated = rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
			photon.fliph(rotated);
			return rotated;
		}
		case 6:
			return rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
		case 7: {
			const rotated = rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
			photon.fliph(rotated);
			return rotated;
		}
		case 8:
			return rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
		default:
			return image;
	}
}

function rotate90(photon: Photon, image: PhotonImage, index: (x: number, y: number, w: number, h: number) => number): PhotonImage {
	const width = image.get_width();
	const height = image.get_height();
	const source = image.get_raw_pixels();
	const destination = new Uint8Array(source.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const from = (y * width + x) * 4;
			const to = index(x, y, width, height) * 4;
			destination[to] = source[from] ?? 0;
			destination[to + 1] = source[from + 1] ?? 0;
			destination[to + 2] = source[from + 2] ?? 0;
			destination[to + 3] = source[from + 3] ?? 0;
		}
	}
	return new photon.PhotonImage(destination, height, width);
}

function exifOrientation(bytes: Uint8Array): number {
	const tiff = jpegTiffOffset(bytes);
	if (tiff < 0) return 1;
	return readOrientation(bytes, tiff);
}

function jpegTiffOffset(bytes: Uint8Array): number {
	if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return -1;
	let offset = 2;
	while (offset < bytes.length - 1) {
		if (bytes[offset] !== 0xff) return -1;
		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			offset++;
			continue;
		}
		if (marker === 0xe1) {
			const start = offset + 4;
			if (start + 6 > bytes.length) return -1;
			if (bytes[start] === 0x45 && bytes[start + 1] === 0x78 && bytes[start + 2] === 0x69 && bytes[start + 3] === 0x66 && bytes[start + 4] === 0 && bytes[start + 5] === 0) {
				return start + 6;
			}
		}
		if (offset + 4 > bytes.length) return -1;
		offset += 2 + ((bytes[offset + 2] ?? 0) << 8 | (bytes[offset + 3] ?? 0));
	}
	return -1;
}

function readOrientation(bytes: Uint8Array, tiffStart: number): number {
	if (tiffStart + 8 > bytes.length) return 1;
	const little = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
	const read16 = (pos: number) => little ? (bytes[pos] ?? 0) | ((bytes[pos + 1] ?? 0) << 8) : ((bytes[pos] ?? 0) << 8) | (bytes[pos + 1] ?? 0);
	const read32 = (pos: number) => little
		? ((bytes[pos] ?? 0) | ((bytes[pos + 1] ?? 0) << 8) | ((bytes[pos + 2] ?? 0) << 16) | ((bytes[pos + 3] ?? 0) << 24)) >>> 0
		: (((bytes[pos] ?? 0) << 24) | ((bytes[pos + 1] ?? 0) << 16) | ((bytes[pos + 2] ?? 0) << 8) | (bytes[pos + 3] ?? 0)) >>> 0;
	const ifd = tiffStart + read32(tiffStart + 4);
	if (ifd + 2 > bytes.length) return 1;
	const count = read16(ifd);
	for (let index = 0; index < count; index++) {
		const entry = ifd + 2 + index * 12;
		if (entry + 12 > bytes.length) return 1;
		if (read16(entry) === 0x0112) {
			const value = read16(entry + 8);
			return value >= 1 && value <= 8 ? value : 1;
		}
	}
	return 1;
}

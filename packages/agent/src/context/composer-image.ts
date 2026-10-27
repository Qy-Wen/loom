/** Composer images: JPEG, PNG, GIF, WebP. Video and audio are not accepted here. */

export const COMPOSER_IMAGE_MAX_COUNT = 4;
export const COMPOSER_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export const COMPOSER_IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export type ComposerImageMime = (typeof COMPOSER_IMAGE_MIMES)[number];

/** Extensions Loom sends to the model as image blocks. Other image files stay library references. */
export const COMPOSER_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/** True when a file with this name or path is sent as an image block. */
export function isComposerImagePath(path: string): boolean {
	const dot = path.lastIndexOf(".");
	return dot >= 0 && COMPOSER_IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export type ComposerImageInput = {
	filename: string;
	mimeType: ComposerImageMime;
	/** Raw base64, without a `data:` prefix. */
	data: string;
};

const MIME_EXT: Record<ComposerImageMime, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

export function sniffComposerImage(bytes: Uint8Array): ComposerImageMime | undefined {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
		return "image/gif";
	}
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	return undefined;
}

function decodedLength(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.floor((data.length * 3) / 4) - padding;
}

function sniffBase64(data: string): ComposerImageMime | undefined {
	if (data.length < 16) return undefined;
	const slice = data.slice(0, 16);
	const padded = slice + "=".repeat((4 - (slice.length % 4)) % 4);
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		return undefined;
	}
	const bytes = new Uint8Array(Math.min(binary.length, 12));
	for (let index = 0; index < bytes.length; index++) bytes[index] = binary.charCodeAt(index);
	return sniffComposerImage(bytes);
}

function cleanFilename(name: unknown, mimeType: ComposerImageMime): string {
	const raw = typeof name === "string" ? name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 180) : "";
	return raw || `image${MIME_EXT[mimeType]}`;
}

/** Validate one composer image. Throws a short message the chat can show. */
export function parseComposerImageInput(value: unknown): ComposerImageInput {
	if (typeof value !== "object" || value === null) throw new Error("Use a JPEG, PNG, GIF, or WebP image.");
	const row = value as { filename?: unknown; mimeType?: unknown; data?: unknown };
	if (typeof row.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(row.data) || row.data.length % 4 !== 0) {
		throw new Error("Image data is invalid.");
	}
	if (decodedLength(row.data) > COMPOSER_IMAGE_MAX_BYTES) throw new Error("Each image must be 8 MB or smaller.");
	const sniffed = sniffBase64(row.data);
	if (!sniffed || row.mimeType !== sniffed) throw new Error("Use a JPEG, PNG, GIF, or WebP image.");
	return { filename: cleanFilename(row.filename, sniffed), mimeType: sniffed, data: row.data };
}

export function parseComposerImageInputs(value: unknown): ComposerImageInput[] {
	if (!Array.isArray(value)) throw new Error("Images are missing.");
	if (value.length > COMPOSER_IMAGE_MAX_COUNT) throw new Error("Attach up to 4 images.");
	return value.map(parseComposerImageInput);
}

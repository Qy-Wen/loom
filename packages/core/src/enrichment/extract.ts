import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";
import type { Asset, AssetType } from "../model/asset.ts";
import {
	TEXT_ENRICHMENT_LIMIT,
	type EnrichmentData,
} from "../model/enrichment.ts";

const execFileAsync = promisify(execFile);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv"]);

export function canExtractText(filename: string): boolean {
	return TEXT_EXTENSIONS.has(extname(filename).toLowerCase());
}

export async function extractEnrichment(absolutePath: string, type: AssetType, filename: string): Promise<EnrichmentData> {
	if (type === "image") return extractImage(absolutePath);
	if (type === "video" || type === "audio") return extractMedia(absolutePath, type);
	if (type === "text" && canExtractText(filename)) return extractText(absolutePath);
	throw new Error("Asset type is not locally enrichable");
}

export function shouldSkipAsset(asset: Asset): string | undefined {
	if (asset.type === "other") return "No local extractor for this file type";
	if (asset.type === "text" && !canExtractText(asset.filename)) {
		return "Text extraction is limited to txt, md, json, and csv";
	}
	return undefined;
}

async function extractText(absolutePath: string): Promise<EnrichmentData> {
	const buffer = await readFile(absolutePath);
	const truncated = buffer.length > TEXT_ENRICHMENT_LIMIT;
	const text = buffer.subarray(0, TEXT_ENRICHMENT_LIMIT).toString("utf8");
	return { kind: "text", text, truncated, charCount: text.length };
}

async function extractImage(absolutePath: string): Promise<EnrichmentData> {
	const buffer = await readFile(absolutePath);
	const size = readImageSize(buffer);
	if (!size) throw new Error("Unsupported or unreadable image format");
	const exif = readJpegExif(buffer);
	return {
		kind: "image",
		width: size.width,
		height: size.height,
		...exif,
	};
}

async function extractMedia(absolutePath: string, type: "video" | "audio"): Promise<EnrichmentData> {
	let stdout: string;
	try {
		const result = await execFileAsync(
			"ffprobe",
			["-v", "error", "-print_format", "json", "-show_format", "-show_streams", absolutePath],
			{ timeout: 20_000, maxBuffer: 2_000_000 },
		);
		stdout = result.stdout;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ffprobe is not installed");
		throw error instanceof Error ? error : new Error(String(error));
	}

	const probe = JSON.parse(stdout) as {
		format?: { duration?: string };
		streams?: Array<{
			codec_type?: string;
			codec_name?: string;
			width?: number;
			height?: number;
			avg_frame_rate?: string;
		}>;
	};
	const duration = Number(probe.format?.duration);
	if (!Number.isFinite(duration)) throw new Error("ffprobe did not return a duration");
	const video = probe.streams?.find((stream) => stream.codec_type === "video");
	const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
	if (type === "audio") {
		return { kind: "audio", duration, audioCodec: audio?.codec_name };
	}
	return {
		kind: "video",
		duration,
		width: video?.width,
		height: video?.height,
		videoCodec: video?.codec_name,
		audioCodec: audio?.codec_name,
		frameRate: parseFrameRate(video?.avg_frame_rate),
	};
}

function parseFrameRate(value: string | undefined): number | undefined {
	if (!value || value === "0/0") return undefined;
	const [numerator, denominator] = value.split("/").map(Number);
	if (!denominator) return Number.isFinite(numerator) ? numerator : undefined;
	const rate = numerator / denominator;
	return Number.isFinite(rate) ? rate : undefined;
}

function readImageSize(buffer: Buffer): { width: number; height: number } | undefined {
	if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
	}
	if (buffer.length >= 26 && buffer.toString("ascii", 0, 2) === "BM") {
		return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
	}
	if (buffer.length >= 10 && (buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a")) {
		return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
	}
	if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
		return readWebpSize(buffer);
	}
	if (buffer[0] === 0xff && buffer[1] === 0xd8) return readJpegSize(buffer);
	return undefined;
}

function readWebpSize(buffer: Buffer): { width: number; height: number } | undefined {
	const chunk = buffer.toString("ascii", 12, 16);
	if (chunk === "VP8X" && buffer.length >= 30) {
		return {
			width: 1 + buffer.readUIntLE(24, 3),
			height: 1 + buffer.readUIntLE(27, 3),
		};
	}
	if (chunk === "VP8 " && buffer.length >= 30) {
		return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
	}
	if (chunk === "VP8L" && buffer.length >= 25) {
		const bits = buffer.readUInt32LE(21);
		return { width: (bits & 0x3fff) + 1, height: (bits >> 14 & 0x3fff) + 1 };
	}
	return undefined;
}

function readJpegSize(buffer: Buffer): { width: number; height: number } | undefined {
	let offset = 2;
	while (offset + 9 < buffer.length && buffer[offset] === 0xff) {
		const marker = buffer[offset + 1];
		const length = buffer.readUInt16BE(offset + 2);
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
		}
		offset += 2 + length;
	}
	return undefined;
}

function readJpegExif(buffer: Buffer): Pick<Extract<EnrichmentData, { kind: "image" }>, "orientation" | "camera" | "capturedAt"> {
	if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return {};
	let offset = 2;
	while (offset + 4 < buffer.length && buffer[offset] === 0xff) {
		const marker = buffer[offset + 1];
		const length = buffer.readUInt16BE(offset + 2);
		if (marker === 0xe1 && buffer.toString("ascii", offset + 4, offset + 8) === "Exif") {
			return parseExif(buffer.subarray(offset + 10, offset + 2 + length));
		}
		offset += 2 + length;
	}
	return {};
}

function parseExif(tiff: Buffer): Pick<Extract<EnrichmentData, { kind: "image" }>, "orientation" | "camera" | "capturedAt"> {
	if (tiff.length < 8) return {};
	const little = tiff.toString("ascii", 0, 2) === "II";
	const read16 = (index: number) => little ? tiff.readUInt16LE(index) : tiff.readUInt16BE(index);
	const read32 = (index: number) => little ? tiff.readUInt32LE(index) : tiff.readUInt32BE(index);
	const ifd = read32(4);
	if (ifd + 2 > tiff.length) return {};
	const count = read16(ifd);
	let orientation: number | undefined;
	let make: string | undefined;
	let model: string | undefined;
	let capturedAt: string | undefined;
	let exifOffset: number | undefined;
	for (let index = 0; index < count; index += 1) {
		const entry = ifd + 2 + index * 12;
		if (entry + 12 > tiff.length) break;
		const tag = read16(entry);
		if (tag === 0x0112) orientation = read16(entry + 8);
		else if (tag === 0x010f) make = readExifString(tiff, entry, little);
		else if (tag === 0x0110) model = readExifString(tiff, entry, little);
		else if (tag === 0x8769) exifOffset = read32(entry + 8);
	}
	if (exifOffset && exifOffset + 2 < tiff.length) {
		const exifCount = read16(exifOffset);
		for (let index = 0; index < exifCount; index += 1) {
			const entry = exifOffset + 2 + index * 12;
			if (entry + 12 > tiff.length) break;
			if (read16(entry) === 0x9003) {
				capturedAt = readExifString(tiff, entry, little)?.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
			}
		}
	}
	const camera = [make, model].filter(Boolean).join(" ").trim() || undefined;
	return { orientation, camera, capturedAt };
}

function readExifString(tiff: Buffer, entry: number, little: boolean): string | undefined {
	const type = little ? tiff.readUInt16LE(entry + 2) : tiff.readUInt16BE(entry + 2);
	const count = little ? tiff.readUInt32LE(entry + 4) : tiff.readUInt32BE(entry + 4);
	if (type !== 2 || count === 0) return undefined;
	const start = count <= 4 ? entry + 8 : (little ? tiff.readUInt32LE(entry + 8) : tiff.readUInt32BE(entry + 8));
	if (start + count > tiff.length) return undefined;
	return tiff.toString("utf8", start, start + count).replaceAll("\0", "").trim() || undefined;
}

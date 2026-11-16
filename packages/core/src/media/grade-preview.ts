import { stat } from "node:fs/promises";
import { buildGradePreviewArgs } from "../grade/filters.ts";
import { runMediaProcessBuffer } from "./run.ts";

const MAX_FRAMES = 4;
const MAX_FRAME_BYTES = 96 * 1024 * 1024;

interface PreviewFrame {
	bytes: Buffer;
	sourceFilter?: string;
	/** NUT omits ICC side data. Copy it once from FFmpeg's JPEG output. */
	icc?: Buffer[];
	original?: Buffer;
}

interface CachedFrame {
	version: string;
	bytes: number;
	pending: Promise<PreviewFrame | null>;
}

/**
 * Lossless decoded frames in memory. Keep the native resolution and pixel format:
 * scaling into a fixed RGB proxy changes FFmpeg's color conversion and rounding.
 * NUT carries the raw frame layout; setparams restores color metadata it omits.
 */
export class GradePreview {
	private readonly frames = new Map<string, CachedFrame>();
	private readonly run: typeof runMediaProcessBuffer;

	constructor(run: typeof runMediaProcessBuffer = runMediaProcessBuffer) {
		this.run = run;
	}

	async render(path: string, filter: string | null, cwd: string, signal?: AbortSignal, timeSeconds?: number): Promise<Buffer> {
		const frame = await this.frame(path, cwd, signal, timeSeconds);
		if (!frame) return this.direct(path, filter, cwd, signal, timeSeconds);
		if (filter === null && frame.original) return frame.original;
		if (frame.icc === undefined) {
			const bytes = await this.direct(path, filter, cwd, signal, timeSeconds);
			frame.icc = jpegIccSegments(bytes);
			if (filter === null) frame.original = bytes;
			return bytes;
		}
		const { stdout } = await this.run({
			program: "ffmpeg",
			args: buildGradePreviewArgs("pipe:0", filter, frame.sourceFilter),
			input: frame.bytes,
			cwd,
			signal,
			timeoutMs: 30_000,
			maxOutputBytes: 16 * 1024 * 1024,
		});
		assertJpeg(stdout);
		const icc = frame.icc;
		// Keep a leading JFIF APP0 segment immediately after SOI.
		const offset = stdout.readUInt16BE(2) === 0xffe0 ? 4 + stdout.readUInt16BE(4) : 2;
		const bytes = icc.length === 0 ? stdout : Buffer.concat([stdout.subarray(0, offset), ...icc, stdout.subarray(offset)]);
		if (filter === null) frame.original = bytes;
		return bytes;
	}

	private async direct(path: string, filter: string | null, cwd: string, signal?: AbortSignal, timeSeconds?: number): Promise<Buffer> {
		const { stdout } = await this.run({
			program: "ffmpeg",
			args: [...(timeSeconds === undefined ? [] : ["-ss", String(Math.round(timeSeconds * 1000) / 1000)]), ...buildGradePreviewArgs(path, filter)],
			cwd, signal, timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024,
		});
		assertJpeg(stdout);
		return stdout;
	}

	clear(): void {
		this.frames.clear();
	}

	private async frame(path: string, cwd: string, signal?: AbortSignal, timeSeconds?: number): Promise<PreviewFrame | null> {
		const info = await stat(path);
		const version = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
		const timeMs = timeSeconds === undefined ? undefined : Math.round(timeSeconds * 1000);
		const key = JSON.stringify([path, timeMs]);
		const hit = this.frames.get(key);
		if (hit?.version === version) {
			this.frames.delete(key);
			this.frames.set(key, hit);
			try {
				return await hit.pending;
			} catch (error) {
				// An older request may have been cancelled while this request waited.
				if (!signal?.aborted && error instanceof Error && error.name === "AbortError") {
					if (this.frames.get(key) === hit) this.frames.delete(key);
					return this.frame(path, cwd, signal, timeSeconds);
				}
				throw error;
			}
		}
		const entry: CachedFrame = { version, bytes: 0, pending: Promise.resolve(null) };
		this.frames.delete(key);
		this.frames.set(key, entry);
		this.trim();
		entry.pending = this.decode(path, cwd, signal, timeMs).then((frame) => {
			if (this.frames.get(key) === entry) {
				entry.bytes = frame?.bytes.length ?? 0;
				this.trim();
			}
			return frame;
		}).catch((error) => {
			if (this.frames.get(key) === entry) this.frames.delete(key);
			throw error;
		});
		return entry.pending;
	}

	private async decode(path: string, cwd: string, signal?: AbortSignal, timeMs?: number): Promise<PreviewFrame | null> {
		try {
			const { stdout, stderr } = await this.run({
				program: "ffmpeg",
				args: [
					"-hide_banner", "-loglevel", "info",
					...(timeMs === undefined ? [] : ["-ss", String(timeMs / 1000)]),
					"-i", path, "-map", "0:v:0", "-vf", "showinfo=checksum=0",
					"-frames:v", "1", "-an", "-c:v", "rawvideo", "-f", "nut", "pipe:1",
				],
				cwd,
				signal,
				timeoutMs: 30_000,
				maxOutputBytes: MAX_FRAME_BYTES,
			});
			return {
				bytes: stdout,
				sourceFilter: frameColorFilter(stderr),
				icc: /side data - ICC profile:/i.test(stderr) ? undefined : [],
			};
		} catch (error) {
			if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
			// Oversized frames and formats NUT cannot represent use the direct path.
			return null;
		}
	}

	private trim(): void {
		let bytes = [...this.frames.values()].reduce((sum, frame) => sum + frame.bytes, 0);
		while (this.frames.size > MAX_FRAMES || bytes > MAX_FRAME_BYTES) {
			const key = this.frames.keys().next().value!;
			bytes -= this.frames.get(key)!.bytes;
			this.frames.delete(key);
		}
	}
}

function assertJpeg(bytes: Buffer): void {
	if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) throw new Error("FFmpeg did not produce a preview frame");
}

function jpegIccSegments(bytes: Buffer): Buffer[] {
	const segments: Buffer[] = [];
	if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return segments;
	for (let offset = 2; offset + 4 <= bytes.length;) {
		const marker = bytes.readUInt16BE(offset);
		if (marker === 0xffda || marker === 0xffd9) break;
		const length = bytes.readUInt16BE(offset + 2);
		if (length < 2 || offset + 2 + length > bytes.length) break;
		if (marker === 0xffe2 && bytes.toString("ascii", offset + 4, offset + 16) === "ICC_PROFILE\0") {
			segments.push(Buffer.from(bytes.subarray(offset, offset + 2 + length)));
		}
		offset += 2 + length;
	}
	return segments;
}

function frameColorFilter(stderr: string): string | undefined {
	const lines = stderr.split(/\r?\n/).filter((line) => /\[Parsed_showinfo_\d+ @/.test(line));
	const format = lines.join("\n").match(/\bfmt:(\w+)/)?.[1];
	const tags = lines.join("\n").match(/color_range:(\S+) color_space:(\S+) color_primaries:(\S+) color_trc:(\S+)/);
	if (!tags || !format) throw new Error("FFmpeg did not report preview frame color metadata");
	const options: string[] = [];
	// RGB decoders' pc flag is implicit. Making it explicit changes downstream
	// YUV filter negotiation; YUV range, on the other hand, must be restored.
	if (format && /^(?:yuv|yuva|nv|p0|p2|p4)/.test(format)) {
		if (tags[1] === "pc") options.push("range=full");
		else if (tags[1] === "tv") options.push("range=limited");
	}
	for (const [key, value] of [["colorspace", tags[2]], ["color_primaries", tags[3]], ["color_trc", tags[4]]]) {
		if (value !== "unknown" && /^[a-z0-9-]+$/.test(value)) options.push(`${key}=${value}`);
	}
	return options.length > 0 ? `setparams=${options.join(":")}` : undefined;
}

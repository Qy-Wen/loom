const CONVERT_FORMATS = new Set([
	"mp4", "webm", "mov", "mkv", "gif", "mp3", "wav", "aac", "png", "jpg", "jpeg", "webp",
]);

export function assertFiniteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative finite number`);
	}
	return value;
}

export function normalizeConvertFormat(format: string): string {
	const normalized = format.trim().toLowerCase().replace(/^\./, "");
	if (normalized === "jpeg") return "jpg";
	if (!CONVERT_FORMATS.has(normalized)) {
		throw new TypeError(`Unsupported format: ${format}`);
	}
	return normalized;
}

export function buildProbeArgs(inputPath: string): string[] {
	return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputPath];
}

export function buildExtractFrameArgs(inputPath: string, outputPath: string, timeSeconds: number): string[] {
	return ["-y", "-ss", formatSeconds(timeSeconds), "-i", inputPath, "-frames:v", "1", outputPath];
}

export function buildExtractClipArgs(
	inputPath: string,
	outputPath: string,
	startSeconds: number,
	durationSeconds: number,
): string[] {
	return [
		"-y",
		"-ss",
		formatSeconds(startSeconds),
		"-i",
		inputPath,
		"-t",
		formatSeconds(durationSeconds),
		outputPath,
	];
}

export function buildResizeArgs(
	inputPath: string,
	outputPath: string,
	options: { width?: number; height?: number; maxEdge?: number },
): string[] {
	return ["-y", "-i", inputPath, "-vf", buildScaleFilter(options), outputPath];
}

export function buildCropArgs(
	inputPath: string,
	outputPath: string,
	crop: { x: number; y: number; width: number; height: number },
): string[] {
	return ["-y", "-i", inputPath, "-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`, outputPath];
}

export function buildConvertArgs(inputPath: string, outputPath: string): string[] {
	return ["-y", "-i", inputPath, outputPath];
}

export function buildScaleFilter(options: { width?: number; height?: number; maxEdge?: number }): string {
	if (options.maxEdge !== undefined) {
		const edge = Math.trunc(options.maxEdge);
		if (edge < 2) throw new TypeError("maxEdge must be at least 2");
		return `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
	}
	if (options.width !== undefined && options.height !== undefined) {
		return `scale=${Math.trunc(options.width)}:${Math.trunc(options.height)}`;
	}
	if (options.width !== undefined) return `scale=${Math.trunc(options.width)}:-2`;
	if (options.height !== undefined) return `scale=-2:${Math.trunc(options.height)}`;
	throw new TypeError("resize requires width, height, or maxEdge");
}

function formatSeconds(value: number): string {
	return String(assertFiniteNumber(value, "time"));
}

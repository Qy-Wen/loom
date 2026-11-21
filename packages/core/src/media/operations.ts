export function assertFiniteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative finite number`);
	}
	return value;
}

export function buildProbeArgs(inputPath: string): string[] {
	return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputPath];
}

export function buildVlmStillArgs(inputPath: string, outputPath: string, timeSeconds: number): string[] {
	return [
		"-y",
		"-ss",
		formatSeconds(timeSeconds),
		"-i",
		inputPath,
		"-frames:v",
		"1",
		"-vf",
		"scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
		outputPath,
	];
}

/** First frame as PNG, for formats a vision model will not take directly (animated GIF). */
export function buildImageStillArgs(inputPath: string, outputPath: string): string[] {
	return ["-y", "-i", inputPath, "-frames:v", "1", outputPath];
}

/**
 * One bounded WebP still. Square thumbnails cover the box, while posters preserve the frame.
 * `seekSeconds` skips a black first frame in video.
 */
export function buildThumbnailArgs(
	inputPath: string, outputPath: string, size: number, seekSeconds?: number, fit: "cover" | "contain" = "cover",
): string[] {
	const scale = `scale=${size}:${size}`;
	return [
		"-y",
		...(seekSeconds ? ["-ss", formatSeconds(seekSeconds)] : []),
		"-i",
		inputPath,
		"-frames:v",
		"1",
		"-vf",
		fit === "cover" ? `${scale}:force_original_aspect_ratio=increase,crop=${size}:${size}` : `${scale}:force_original_aspect_ratio=decrease:reset_sar=1`,
		"-c:v",
		"libwebp",
		"-quality",
		"75",
		"-f",
		"webp",
		outputPath,
	];
}

export function buildAudioCompactArgs(inputPath: string, outputPath: string): string[] {
	return [
		"-y",
		"-i",
		inputPath,
		"-vn",
		"-ac",
		"1",
		"-ar",
		"16000",
		"-b:a",
		"48k",
		outputPath,
	];
}

function formatSeconds(value: number): string {
	return String(assertFiniteNumber(value, "time"));
}

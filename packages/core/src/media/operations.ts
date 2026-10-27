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

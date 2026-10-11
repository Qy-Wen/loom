import { isFullImageCrop, isIdentityCurve, type ImageGrade } from "./types.ts";

/**
 * One filtergraph for preview and export.
 * Omitted filters are at the FFmpeg default, so an unchanged grade produces no graph.
 * Order: rotation, mirror, crop, then exposure, eq, vibrance, huesaturation,
 * colortemperature, colorlevels, curves, lut3d.
 * Crop is measured on the frame after rotation and mirroring.
 */
export function buildImageGradeFilter(grade: ImageGrade, lutAbsolutePath?: string): string | null {
	const filters: string[] = [...geometryFilters(grade)];
	if (grade.exposure !== 0) filters.push(`exposure=exposure=${formatNumber(grade.exposure)}`);
	const eq = eqOptions(grade);
	if (eq) filters.push(eq);
	if (grade.vibrance !== 0) filters.push(`vibrance=intensity=${formatNumber(grade.vibrance)}`);
	const hue = hueOptions(grade);
	if (hue) filters.push(hue);
	if (grade.temperature !== 6500) filters.push(`colortemperature=temperature=${grade.temperature}`);
	if (grade.black !== 0 || grade.white !== 1) {
		const black = formatNumber(grade.black);
		const white = formatNumber(grade.white);
		filters.push(
			`colorlevels=rimin=${black}:gimin=${black}:bimin=${black}:rimax=${white}:gimax=${white}:bimax=${white}`,
		);
	}
	const curves = curveOptions(grade);
	if (curves) filters.push(curves);
	if (lutAbsolutePath) filters.push(`lut3d=file='${escapeFfmpegFilterPath(lutAbsolutePath)}'`);
	return filters.length > 0 ? filters.join(",") : null;
}

/** Escape a filesystem path for a single-quoted FFmpeg filter option. */
export function escapeFfmpegFilterPath(absolutePath: string): string {
	return absolutePath.replaceAll("\\", "/").replace(/[':,[\];]/g, (char) => `\\${char}`);
}

export function buildGradeImageArgs(
	inputPath: string,
	outputPath: string,
	filter: string | null,
	proxy: boolean,
): string[] {
	const chain = [
		proxy ? "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease" : "",
		filter ?? "",
	].filter(Boolean);
	const args = ["-y", "-i", inputPath];
	if (chain.length > 0) args.push("-vf", chain.join(","));
	args.push("-frames:v", "1");
	if (proxy || /\.jpe?g$/i.test(outputPath)) args.push("-q:v", proxy ? "4" : "2");
	if (!proxy && /\.webp$/i.test(outputPath)) args.push("-c:v", "libwebp", "-quality", "85");
	args.push("-update", "1", outputPath);
	return args;
}

function geometryFilters(grade: ImageGrade): string[] {
	const filters: string[] = [];
	if (grade.rotation === 1) filters.push("transpose=1");
	else if (grade.rotation === 2) filters.push("hflip", "vflip");
	else if (grade.rotation === 3) filters.push("transpose=2");
	if (grade.flipH) filters.push("hflip");
	if (grade.flipV) filters.push("vflip");
	if (!isFullImageCrop(grade.crop)) {
		const { x, y, w, h } = grade.crop;
		filters.push(
			`crop=trunc(iw*${formatUnit(w)}):trunc(ih*${formatUnit(h)}):trunc(iw*${formatUnit(x)}):trunc(ih*${formatUnit(y)})`,
		);
	}
	return filters;
}

function eqOptions(grade: ImageGrade): string | null {
	const options: string[] = [];
	if (grade.brightness !== 0) options.push(`brightness=${formatNumber(grade.brightness)}`);
	if (grade.contrast !== 1) options.push(`contrast=${formatNumber(grade.contrast)}`);
	if (grade.saturation !== 1) options.push(`saturation=${formatNumber(grade.saturation)}`);
	return options.length > 0 ? `eq=${options.join(":")}` : null;
}

function hueOptions(grade: ImageGrade): string | null {
	const options: string[] = [];
	if (grade.hue !== 0) options.push(`hue=${formatNumber(grade.hue)}`);
	if (grade.lightness !== 0) options.push(`intensity=${formatNumber(grade.lightness)}`);
	return options.length > 0 ? `huesaturation=${options.join(":")}` : null;
}

function curveOptions(grade: ImageGrade): string | null {
	const options: string[] = [];
	pushCurve(options, "master", grade.curves.rgb);
	pushCurve(options, "red", grade.curves.r);
	pushCurve(options, "green", grade.curves.g);
	pushCurve(options, "blue", grade.curves.b);
	return options.length > 0 ? `curves=${options.join(":")}` : null;
}

function pushCurve(options: string[], name: string, points: ImageGrade["curves"]["rgb"]): void {
	if (isIdentityCurve(points)) return;
	const coordinates = points.map((point) => `${formatUnit(point.x)}/${formatUnit(point.y)}`).join(" ");
	options.push(`${name}='${coordinates}'`);
}

function formatNumber(value: number): string {
	const rounded = Math.round(value * 1000) / 1000;
	return Object.is(rounded, -0) ? "0" : String(rounded);
}

function formatUnit(value: number): string {
	const rounded = Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
	return String(rounded);
}

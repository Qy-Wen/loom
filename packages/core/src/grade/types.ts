/** Grade recipe for a still or a whole video. Numbers are FFmpeg filter parameters, not a remapped scale. */

export interface CurvePoint {
	x: number;
	y: number;
}

export interface ImageGradeCurves {
	rgb: CurvePoint[];
	r: CurvePoint[];
	g: CurvePoint[];
	b: CurvePoint[];
}

/** Axis-aligned crop of the frame after rotation and mirroring. Edges are 0..1. */
export interface ImageCrop {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type ImageRotation = 0 | 1 | 2 | 3;

export type CropHandle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const FULL_IMAGE_CROP: ImageCrop = { x: 0, y: 0, w: 1, h: 1 };

/** Smallest crop the on-image handles can drag to. Stored crops may be tighter. */
const MIN_CROP_DRAG = 0.05;
const MIN_STORED_CROP = 0.001;

export interface ImageGrade {
	/** Quarter turns clockwise. 0 leaves the image unchanged. */
	rotation: ImageRotation;
	/** Mirror left to right after rotation. */
	flipH: boolean;
	/** Mirror top to bottom after rotation. */
	flipV: boolean;
	crop: ImageCrop;
	/** `exposure` filter, EV. −3..3, 0 leaves the image unchanged. */
	exposure: number;
	/** `eq` brightness. −1..1, 0 leaves the image unchanged. */
	brightness: number;
	/** `huesaturation` intensity. −1..1, 0 leaves the image unchanged. */
	lightness: number;
	/** `eq` contrast. 1 leaves the image unchanged. */
	contrast: number;
	/** `huesaturation` hue shift in degrees. −180..180, 0 leaves the image unchanged. */
	hue: number;
	/** `eq` saturation. 1 leaves the image unchanged. */
	saturation: number;
	/** `vibrance` intensity. −2..2, 0 leaves the image unchanged. */
	vibrance: number;
	/** `colortemperature` Kelvin. 6500 leaves the image unchanged. */
	temperature: number;
	/** `colorlevels` input black point, shared by RGB. 0 leaves it unchanged. */
	black: number;
	/** `colorlevels` input white point, shared by RGB. 1 leaves it unchanged. */
	white: number;
	curves: ImageGradeCurves;
}

export const GRADEABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
	".bmp",
	".gif",
	".jpeg",
	".jpg",
	".png",
	".tif",
	".tiff",
	".webp",
]);

const IDENTITY_CURVE: CurvePoint[] = [
	{ x: 0, y: 0 },
	{ x: 1, y: 1 },
];

export const IDENTITY_IMAGE_GRADE: ImageGrade = {
	rotation: 0,
	flipH: false,
	flipV: false,
	crop: { ...FULL_IMAGE_CROP },
	exposure: 0,
	brightness: 0,
	lightness: 0,
	contrast: 1,
	hue: 0,
	saturation: 1,
	vibrance: 0,
	temperature: 6500,
	black: 0,
	white: 1,
	curves: {
		rgb: IDENTITY_CURVE.map((point) => ({ ...point })),
		r: IDENTITY_CURVE.map((point) => ({ ...point })),
		g: IDENTITY_CURVE.map((point) => ({ ...point })),
		b: IDENTITY_CURVE.map((point) => ({ ...point })),
	},
};

const MAX_CURVE_POINTS = 16;

export function imageExtension(filename: string): string {
	const slash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
	const base = slash >= 0 ? filename.slice(slash + 1) : filename;
	const dot = base.lastIndexOf(".");
	return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

export const GRADEABLE_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
	".avi",
	".m4v",
	".mkv",
	".mov",
	".mp4",
	".webm",
]);

export function isGradeableImage(filename: string): boolean {
	return GRADEABLE_IMAGE_EXTENSIONS.has(imageExtension(filename));
}

export function isGradeableVideo(filename: string): boolean {
	return GRADEABLE_VIDEO_EXTENSIONS.has(imageExtension(filename));
}

export function isIdentityCurve(points: CurvePoint[]): boolean {
	return points.length === 2
		&& points[0].x === 0
		&& points[0].y === 0
		&& points[1].x === 1
		&& points[1].y === 1;
}

export function isFullImageCrop(crop: ImageCrop): boolean {
	return crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1;
}

/** Keep the same pixels selected when the frame turns clockwise by `quarterTurns`. */
export function rotateCrop(crop: ImageCrop, quarterTurns: number): ImageCrop {
	const turns = ((Math.trunc(quarterTurns) % 4) + 4) % 4;
	let next = crop;
	for (let step = 0; step < turns; step += 1) {
		next = { x: round4(1 - (next.y + next.h)), y: next.x, w: next.h, h: next.w };
	}
	return next;
}

/** Keep the same pixels selected when the oriented frame is mirrored. */
export function flipCrop(crop: ImageCrop, axis: "h" | "v"): ImageCrop {
	if (axis === "h") return { x: round4(1 - (crop.x + crop.w)), y: crop.y, w: crop.w, h: crop.h };
	return { x: crop.x, y: round4(1 - (crop.y + crop.h)), w: crop.w, h: crop.h };
}

/** Move or resize a normalized crop. `dx` and `dy` are fractions of the frame. */
export function adjustCrop(crop: ImageCrop, handle: CropHandle, dx: number, dy: number): ImageCrop {
	let x = crop.x;
	let y = crop.y;
	let w = crop.w;
	let h = crop.h;
	const west = handle === "w" || handle === "nw" || handle === "sw";
	const east = handle === "e" || handle === "ne" || handle === "se";
	const north = handle === "n" || handle === "ne" || handle === "nw";
	const south = handle === "s" || handle === "se" || handle === "sw";
	if (handle === "move") {
		x += dx;
		y += dy;
	}
	if (west) {
		x += dx;
		w -= dx;
	}
	if (east) w += dx;
	if (north) {
		y += dy;
		h -= dy;
	}
	if (south) h += dy;
	if (w < MIN_CROP_DRAG) {
		if (west) x -= MIN_CROP_DRAG - w;
		w = MIN_CROP_DRAG;
	}
	if (h < MIN_CROP_DRAG) {
		if (north) y -= MIN_CROP_DRAG - h;
		h = MIN_CROP_DRAG;
	}
	if (x < 0) {
		if (handle !== "move") w += x;
		x = 0;
	}
	if (y < 0) {
		if (handle !== "move") h += y;
		y = 0;
	}
	if (x + w > 1) {
		if (handle === "move" || west) x = 1 - w;
		else w = 1 - x;
	}
	if (y + h > 1) {
		if (handle === "move" || north) y = 1 - h;
		else h = 1 - y;
	}
	return normalizeCrop({ x, y, w, h });
}

export function isNeutralImageGrade(grade: ImageGrade): boolean {
	return grade.rotation === 0
		&& !grade.flipH
		&& !grade.flipV
		&& isFullImageCrop(grade.crop)
		&& grade.exposure === 0
		&& grade.brightness === 0
		&& grade.lightness === 0
		&& grade.contrast === 1
		&& grade.hue === 0
		&& grade.saturation === 1
		&& grade.vibrance === 0
		&& grade.temperature === 6500
		&& grade.black === 0
		&& grade.white === 1
		&& isIdentityCurve(grade.curves.rgb)
		&& isIdentityCurve(grade.curves.r)
		&& isIdentityCurve(grade.curves.g)
		&& isIdentityCurve(grade.curves.b);
}

export function normalizeCurve(value: unknown): CurvePoint[] {
	const raw = Array.isArray(value) ? value : [];
	const parsed: CurvePoint[] = [];
	for (const point of raw) {
		if (!point || typeof point !== "object") continue;
		const record = point as { x?: unknown; y?: unknown };
		if (typeof record.x !== "number" || typeof record.y !== "number") continue;
		if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) continue;
		parsed.push({ x: clamp(record.x, 0, 1), y: clamp(record.y, 0, 1) });
	}
	parsed.sort((a, b) => a.x - b.x);
	const unique: CurvePoint[] = [];
	for (const point of parsed) {
		const previous = unique.at(-1);
		if (previous && Math.abs(previous.x - point.x) < 0.0001) unique[unique.length - 1] = point;
		else unique.push(point);
	}
	if (unique.length === 0 || unique[0].x > 0) unique.unshift({ x: 0, y: 0 });
	if (unique[unique.length - 1].x < 1) unique.push({ x: 1, y: 1 });
	unique[0] = { x: 0, y: unique[0].y };
	unique[unique.length - 1] = { x: 1, y: unique[unique.length - 1].y };
	if (unique.length <= MAX_CURVE_POINTS) return unique;
	return [unique[0], ...unique.slice(1, -1).slice(0, MAX_CURVE_POINTS - 2), unique[unique.length - 1]];
}

export function normalizeImageGrade(value: unknown): ImageGrade {
	const record = isRecord(value) ? value : {};
	const curves = isRecord(record.curves) ? record.curves : {};
	let black = clampNum(record.black, 0, 1, 0);
	let white = clampNum(record.white, 0, 1, 1);
	if (black > white) black = white;
	if (white - black < 0.001) {
		if (white > 0.001) black = white - 0.001;
		else white = black + 0.001;
	}
	return {
		rotation: normalizeRotation(record.rotation),
		flipH: record.flipH === true,
		flipV: record.flipV === true,
		crop: normalizeCrop(record.crop),
		exposure: round3(clampNum(record.exposure, -3, 3, 0)),
		brightness: round3(clampNum(record.brightness, -1, 1, 0)),
		lightness: round3(clampNum(record.lightness, -1, 1, 0)),
		contrast: round3(clampNum(record.contrast, 0, 2, 1)),
		hue: Math.round(clampNum(record.hue, -180, 180, 0)),
		saturation: round3(clampNum(record.saturation, 0, 3, 1)),
		vibrance: round3(clampNum(record.vibrance, -2, 2, 0)),
		temperature: Math.round(clampNum(record.temperature, 1000, 40000, 6500)),
		black: round3(black),
		white: round3(white),
		curves: {
			rgb: normalizeCurve(curves.rgb),
			r: normalizeCurve(curves.r),
			g: normalizeCurve(curves.g),
			b: normalizeCurve(curves.b),
		},
	};
}

export function normalizeCrop(value: unknown): ImageCrop {
	if (!isRecord(value)) return { ...FULL_IMAGE_CROP };
	let x = clampNum(value.x, 0, 1, 0);
	let y = clampNum(value.y, 0, 1, 0);
	let w = clampNum(value.w, MIN_STORED_CROP, 1, 1);
	let h = clampNum(value.h, MIN_STORED_CROP, 1, 1);
	if (x + w > 1) w = 1 - x;
	if (y + h > 1) h = 1 - y;
	if (w < MIN_STORED_CROP) {
		x = Math.max(0, x - (MIN_STORED_CROP - w));
		w = MIN_STORED_CROP;
	}
	if (h < MIN_STORED_CROP) {
		y = Math.max(0, y - (MIN_STORED_CROP - h));
		h = MIN_STORED_CROP;
	}
	const cropped = { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
	if (cropped.x + cropped.w > 1) cropped.w = round4(1 - cropped.x);
	if (cropped.y + cropped.h > 1) cropped.h = round4(1 - cropped.y);
	return cropped;
}

function normalizeRotation(value: unknown): ImageRotation {
	const turns = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
	if (turns === 1 || turns === 2 || turns === 3) return turns;
	return 0;
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return clamp(value, min, max);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function round4(value: number): number {
	return Math.round(value * 10000) / 10000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

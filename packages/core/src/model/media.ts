export interface MediaInfoResult {
	kind: "media_info";
	path: string;
	duration?: number;
	width?: number;
	height?: number;
	videoCodec?: string;
	audioCodec?: string;
	frameRate?: number;
	format?: string;
}

export interface MediaJobResult {
	kind: "media_job";
	program: "ffmpeg" | "ffprobe";
	output?: string;
	outputs?: string[];
	stdout?: string;
}

export interface ExtractFrameArgs {
	path: string;
	timeSeconds: number;
	output?: string;
}

export interface ExtractClipArgs {
	path: string;
	startSeconds: number;
	durationSeconds: number;
	output?: string;
}

export interface ResizeVideoArgs {
	path: string;
	width?: number;
	height?: number;
	maxEdge?: number;
	output?: string;
}

export interface CropVideoArgs {
	path: string;
	x: number;
	y: number;
	width: number;
	height: number;
	output?: string;
}

export interface ConvertFormatArgs {
	path: string;
	format: string;
	output?: string;
}

export interface RunFfmpegArgs {
	program?: "ffmpeg" | "ffprobe";
	args: string[];
}

export interface GradeImageArgs {
	path: string;
	output?: string;
	/** When `output` is omitted, write beside the source as `name_grade.ext` instead of `outputs/`. */
	beside?: boolean;
	grade: unknown;
	lut?: string;
}

export interface GradeImageResult {
	kind: "grade_image";
	output: string;
	assetId: string;
	sourceAssetId?: string;
}

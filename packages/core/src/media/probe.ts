export interface MediaProbeFields {
	duration?: number;
	width?: number;
	height?: number;
	videoCodec?: string;
	audioCodec?: string;
	frameRate?: number;
	format?: string;
}

export function parseFfprobeJson(stdout: string): MediaProbeFields {
	const probe = JSON.parse(stdout) as {
		format?: { duration?: string; format_name?: string };
		streams?: Array<{
			codec_type?: string;
			codec_name?: string;
			width?: number;
			height?: number;
			avg_frame_rate?: string;
		}>;
	};
	const duration = Number(probe.format?.duration);
	const video = probe.streams?.find((stream) => stream.codec_type === "video");
	const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
	return {
		duration: Number.isFinite(duration) ? duration : undefined,
		width: video?.width,
		height: video?.height,
		videoCodec: video?.codec_name,
		audioCodec: audio?.codec_name,
		frameRate: parseFrameRate(video?.avg_frame_rate),
		format: probe.format?.format_name,
	};
}

function parseFrameRate(value: string | undefined): number | undefined {
	if (!value || value === "0/0") return undefined;
	const [numerator, denominator] = value.split("/").map(Number);
	if (!denominator) return Number.isFinite(numerator) ? numerator : undefined;
	const rate = numerator / denominator;
	return Number.isFinite(rate) ? rate : undefined;
}

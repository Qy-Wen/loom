export const VIDEO_VLM_NATIVE_MAX_BYTES = 32 * 1024 * 1024;

export const VIDEO_VLM_SYSTEM_PROMPT =
	"You describe one video for a local asset library. " +
	"Reply with Markdown only, using exactly these headings:\n" +
	"## Caption\n" +
	"Two to six sentences covering what happens. Include any readable on-screen text.\n" +
	"## Tags\n" +
	"A short comma-separated list of tags.";

export const VIDEO_VLM_USER_PROMPT = "Describe this video.";

export const VIDEO_VLM_FRAMES_PROMPT =
	"These stills are from the same video, in time order. Describe the video.";

export type VideoVlmJobStatus = "describing" | "ready" | "failed";
export type VideoVlmStatusKind = "idle" | VideoVlmJobStatus;

export interface VideoVlmFrame {
	filename: string;
	bytes: Uint8Array;
}

export interface VideoVlmNativeInput {
	filename: string;
	bytes: Uint8Array;
}

export interface VideoVlmDescribeRequest {
	native?: VideoVlmNativeInput;
	frames: () => Promise<VideoVlmFrame[]>;
}

export interface VideoVlmProvider {
	modelId: string;
	describe(request: VideoVlmDescribeRequest): Promise<string>;
}

export interface VideoVlmRecord {
	assetId: string;
	status: VideoVlmJobStatus;
	modelId?: string;
	sourceModifiedAt: number;
	error?: string;
	markdown?: string;
	updatedAt: number;
}

export interface VideoVlmStatus {
	assetId: string;
	status: VideoVlmStatusKind;
	stale: boolean;
	supported: boolean;
	modelId?: string;
	sourceModifiedAt?: number;
	error?: string;
	markdown?: string;
}

export type VideoFrameExtractor = (absolutePath: string) => Promise<VideoVlmFrame[]>;

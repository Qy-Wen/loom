import type { DescriptionJobStatus, DescriptionRecord, DescriptionStatus, DescriptionStatusKind } from "./description.ts";

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

export type VideoVlmJobStatus = DescriptionJobStatus;
export type VideoVlmStatusKind = DescriptionStatusKind;

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
	describe(request: VideoVlmDescribeRequest, signal?: AbortSignal): Promise<string>;
}

export type VideoVlmRecord = DescriptionRecord;
export type VideoVlmStatus = DescriptionStatus;

export type VideoFrameExtractor = (absolutePath: string, signal?: AbortSignal) => Promise<VideoVlmFrame[]>;

import type { DescriptionJobStatus, DescriptionRecord, DescriptionStatus, DescriptionStatusKind } from "./description.ts";

export const VIDEO_VLM_NATIVE_MAX_BYTES = 32 * 1024 * 1024;

export const VIDEO_VLM_SYSTEM_PROMPT =
	"You describe one video for a local asset library. " +
	'Return only a JSON object with "caption" (non-empty plain text) and "tags" (an array of 3 to 5 concise tag names). No Markdown or code fences. ' +
	"Describe the visible events and setting in two to six sentences. Include readable on-screen text. Do not infer events that the input does not show.";

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

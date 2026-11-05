import type { DescriptionJobStatus, DescriptionRecord, DescriptionStatus, DescriptionStatusKind } from "./description.ts";

export const IMAGE_VLM_MAX_BYTES = 10 * 1024 * 1024;

export const IMAGE_VLM_SYSTEM_PROMPT =
	"You describe one image for a local asset library. " +
	'Return only a JSON object with "caption" (non-empty plain text) and "tags" (an array of 3 to 5 concise tag names). No Markdown or code fences. ' +
	"Describe the visible subjects, setting, composition, colors, lighting, and style in two to six sentences. Include readable text. Do not invent details.";

export const IMAGE_VLM_USER_PROMPT = "Describe this image.";

export type ImageVlmJobStatus = DescriptionJobStatus;
export type ImageVlmStatusKind = DescriptionStatusKind;

export interface ImageVlmInput {
	filename: string;
	bytes: Uint8Array;
}

/** Reads the file for the model. Formats it cannot accept are converted first. */
export type ImagePrepareFn = (
	absolutePath: string,
	signal?: AbortSignal,
) => Promise<ImageVlmInput>;

export interface ImageVlmProvider {
	modelId: string;
	describe(image: ImageVlmInput, signal?: AbortSignal): Promise<string>;
}

export type ImageVlmRecord = DescriptionRecord;
export type ImageVlmStatus = DescriptionStatus;

export const IMAGE_VLM_MAX_BYTES = 10 * 1024 * 1024;

export const IMAGE_VLM_SYSTEM_PROMPT =
	"You describe one image for a local asset library. " +
	"Reply with Markdown only, using exactly these headings:\n" +
	"## Caption\n" +
	"Two to six sentences. Include any readable text in the image.\n" +
	"## Tags\n" +
	"A short comma-separated list of tags.";

export const IMAGE_VLM_USER_PROMPT = "Describe this image.";

export type ImageVlmJobStatus = "describing" | "ready" | "failed";
export type ImageVlmStatusKind = "idle" | ImageVlmJobStatus;

export interface ImageVlmInput {
	filename: string;
	bytes: Uint8Array;
}

export interface ImageVlmProvider {
	modelId: string;
	describe(image: ImageVlmInput): Promise<string>;
}

export interface ImageVlmRecord {
	assetId: string;
	status: ImageVlmJobStatus;
	modelId?: string;
	sourceModifiedAt: number;
	error?: string;
	markdown?: string;
	updatedAt: number;
}

export interface ImageVlmStatus {
	assetId: string;
	status: ImageVlmStatusKind;
	stale: boolean;
	supported: boolean;
	modelId?: string;
	sourceModifiedAt?: number;
	error?: string;
	markdown?: string;
}

export function normalizeImageVlmMarkdown(raw: string): string {
	const text = raw.trim();
	if (!text) throw new Error("VLM returned an empty description");
	if (/^##\s+Caption\b/im.test(text)) return text;
	return `## Caption\n${text}\n`;
}

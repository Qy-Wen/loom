import {
	IMAGE_VLM_SYSTEM_PROMPT,
	IMAGE_VLM_USER_PROMPT,
	VIDEO_VLM_FRAMES_PROMPT,
	VIDEO_VLM_SYSTEM_PROMPT,
	VIDEO_VLM_USER_PROMPT,
	type ImageVlmInput,
	type ImageVlmProvider,
	type VideoVlmFrame,
	type VideoVlmNativeInput,
	type VideoVlmProvider,
} from "@loom/core";
import { extname } from "node:path";

const IMAGE_MEDIA_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

const VIDEO_MEDIA_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
};

const nativeVideoRejected = new Set<string>();

export function resetNativeVideoProbeForTests(): void {
	nativeVideoRejected.clear();
}

export function vlmChatUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (!trimmed) throw new Error("VLM base URL is required");
	if (trimmed.toLowerCase().endsWith("/chat/completions")) return trimmed;
	if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/chat/completions`;
	return `${trimmed}/v1/chat/completions`;
}

export function imageDataUrl(image: ImageVlmInput): string {
	const mediaType = IMAGE_MEDIA_TYPES[extname(image.filename).toLowerCase()];
	if (!mediaType) throw new Error("VLM accepts JPEG, PNG, WebP, or BMP images");
	return `data:${mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

export function videoDataUrl(video: VideoVlmNativeInput): string {
	const mediaType = VIDEO_MEDIA_TYPES[extname(video.filename).toLowerCase()];
	if (!mediaType) throw new Error("VLM native video needs mp4, webm, mov, mkv, m4v, or avi");
	return `data:${mediaType};base64,${Buffer.from(video.bytes).toString("base64")}`;
}

export function shouldFallbackFromNativeVideo(status: number, body: string): boolean {
	if (status === 401 || status === 403) return false;
	if (status === 400 || status === 413 || status === 415 || status === 422) return true;
	if (status >= 500) return true;
	return /video_url|unsupported.*video|invalid.*content|unknown.*type|does not support/i.test(body);
}

export function createHttpVlmProvider(slot: {
	baseUrl: string;
	apiKey: string;
	model: string;
}): ImageVlmProvider {
	const modelId = slot.model.trim();
	const url = vlmChatUrl(slot.baseUrl);
	if (!modelId) throw new Error("VLM model is required");
	const apiKey = slot.apiKey.trim();
	return {
		modelId,
		async describe(image: ImageVlmInput): Promise<string> {
			return postVlm(url, apiKey, vlmRequestBody(modelId, imageDataUrl(image)));
		},
	};
}

export function createHttpVideoVlmProvider(slot: {
	baseUrl: string;
	apiKey: string;
	model: string;
}): VideoVlmProvider {
	const modelId = slot.model.trim();
	const url = vlmChatUrl(slot.baseUrl);
	if (!modelId) throw new Error("VLM model is required");
	const apiKey = slot.apiKey.trim();
	const probeKey = `${url}|${modelId}`;
	return {
		modelId,
		async describe(request): Promise<string> {
			if (request.native && !nativeVideoRejected.has(probeKey)) {
				try {
					return await postVlm(url, apiKey, vlmVideoRequestBody(modelId, videoDataUrl(request.native)));
				} catch (error) {
					if (!nativeFallbackError(error)) throw error;
					nativeVideoRejected.add(probeKey);
				}
			}
			const frames = await request.frames();
			if (frames.length === 0) throw new Error("Could not extract video frames for VLM");
			return postVlm(url, apiKey, vlmFrameRequestBody(modelId, frames));
		},
	};
}

export function vlmRequestBody(modelId: string, dataUrl: string): Record<string, unknown> {
	return chatBody(modelId, IMAGE_VLM_SYSTEM_PROMPT, [
		{ type: "text", text: IMAGE_VLM_USER_PROMPT },
		{ type: "image_url", image_url: { url: dataUrl } },
	]);
}

export function vlmVideoRequestBody(modelId: string, dataUrl: string): Record<string, unknown> {
	return chatBody(modelId, VIDEO_VLM_SYSTEM_PROMPT, [
		{ type: "text", text: VIDEO_VLM_USER_PROMPT },
		{ type: "video_url", video_url: { url: dataUrl } },
	]);
}

export function vlmFrameRequestBody(modelId: string, frames: VideoVlmFrame[]): Record<string, unknown> {
	return chatBody(modelId, VIDEO_VLM_SYSTEM_PROMPT, [
		{ type: "text", text: VIDEO_VLM_FRAMES_PROMPT },
		...frames.map((frame) => ({
			type: "image_url",
			image_url: { url: imageDataUrl(frame) },
		})),
	]);
}

export function parseVlmResponse(body: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("VLM response is not JSON");
	}
	const text = openaiMessageText(parsed);
	if (!text) throw new Error("VLM response is missing text");
	return text;
}

function chatBody(
	modelId: string,
	system: string,
	content: Array<Record<string, unknown>>,
): Record<string, unknown> {
	return {
		model: modelId,
		max_tokens: 1024,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content },
		],
	};
}

async function postVlm(url: string, apiKey: string, payload: Record<string, unknown>): Promise<string> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
	});
	const body = await response.text();
	if (!response.ok) {
		throw new Error(`VLM request failed (${response.status}): ${body.slice(0, 240)}`);
	}
	return parseVlmResponse(body);
}

function nativeFallbackError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const match = error.message.match(/VLM request failed \((\d+)\)/);
	if (!match) return false;
	const status = Number(match[1]);
	const body = error.message.slice(error.message.indexOf(":") + 1);
	return shouldFallbackFromNativeVideo(status, body);
}

function openaiMessageText(parsed: unknown): string | undefined {
	if (!parsed || typeof parsed !== "object" || !("choices" in parsed) || !Array.isArray(parsed.choices)) {
		return undefined;
	}
	const choice = parsed.choices[0];
	if (!choice || typeof choice !== "object" || !("message" in choice)) return undefined;
	return contentText(choice.message);
}

function contentText(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (!("content" in value)) return undefined;
	const content = value.content;
	if (typeof content === "string") {
		const text = content.trim();
		return text || undefined;
	}
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			parts.push(part);
			continue;
		}
		if (!part || typeof part !== "object") continue;
		if ("text" in part && typeof part.text === "string") parts.push(part.text);
	}
	const text = parts.join("").trim();
	return text || undefined;
}

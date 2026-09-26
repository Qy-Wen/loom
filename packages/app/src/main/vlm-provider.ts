import {
	IMAGE_VLM_SYSTEM_PROMPT,
	IMAGE_VLM_USER_PROMPT,
	type ImageVlmInput,
	type ImageVlmProvider,
} from "@loom/core";
import { extname } from "node:path";

const MEDIA_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

export function vlmChatUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (!trimmed) throw new Error("VLM base URL is required");
	if (trimmed.toLowerCase().endsWith("/chat/completions")) return trimmed;
	if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/chat/completions`;
	return `${trimmed}/v1/chat/completions`;
}

export function imageDataUrl(image: ImageVlmInput): string {
	const mediaType = MEDIA_TYPES[extname(image.filename).toLowerCase()];
	if (!mediaType) throw new Error("VLM accepts JPEG, PNG, WebP, or BMP images");
	return `data:${mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`;
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
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (apiKey) headers.authorization = `Bearer ${apiKey}`;
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(vlmRequestBody(modelId, imageDataUrl(image))),
			});
			const body = await response.text();
			if (!response.ok) {
				throw new Error(`VLM request failed (${response.status}): ${body.slice(0, 240)}`);
			}
			return parseVlmResponse(body);
		},
	};
}

export function vlmRequestBody(modelId: string, dataUrl: string): Record<string, unknown> {
	return {
		model: modelId,
		max_tokens: 1024,
		messages: [
			{ role: "system", content: IMAGE_VLM_SYSTEM_PROMPT },
			{
				role: "user",
				content: [
					{ type: "text", text: IMAGE_VLM_USER_PROMPT },
					{ type: "image_url", image_url: { url: dataUrl } },
				],
			},
		],
	};
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

import {
	AUDIO_WRITEUP_SYSTEM_PROMPT,
	AUDIO_WRITEUP_USER_PROMPT,
	IMAGE_VLM_SYSTEM_PROMPT,
	IMAGE_VLM_USER_PROMPT,
	VIDEO_VLM_FRAMES_PROMPT,
	VIDEO_VLM_SYSTEM_PROMPT,
	VIDEO_VLM_USER_PROMPT,
	type AudioWriteupInput,
	type AudioWriteupProvider,
	type ImageVlmInput,
	type ImageVlmProvider,
	type VideoVlmFrame,
	type VideoVlmNativeInput,
	type VideoVlmProvider,
} from "@loom/core";
import { extname } from "node:path";
import { modelRequestUrl } from "../shared/model-request-url.ts";

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

const AUDIO_MEDIA_TYPES: Record<string, string> = {
	".aac": "audio/aac",
	".flac": "audio/flac",
	".m4a": "audio/mp4",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
};

const INPUT_AUDIO_FORMATS = new Set(["wav", "mp3", "flac", "ogg"]);
const nativeVideoRejected = new Set<string>();
const audioUrlRejected = new Set<string>();

export function resetNativeVideoProbeForTests(): void {
	nativeVideoRejected.clear();
	audioUrlRejected.clear();
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
	const url = modelRequestUrl(slot.baseUrl);
	if (!modelId) throw new Error("VLM model is required");
	const apiKey = slot.apiKey.trim();
	return {
		modelId,
		async describe(image: ImageVlmInput, signal?: AbortSignal): Promise<string> {
			return postVlm(url, apiKey, vlmRequestBody(modelId, imageDataUrl(image)), signal);
		},
	};
}

export function createHttpVideoVlmProvider(slot: {
	baseUrl: string;
	apiKey: string;
	model: string;
}): VideoVlmProvider {
	const modelId = slot.model.trim();
	const url = modelRequestUrl(slot.baseUrl);
	if (!modelId) throw new Error("VLM model is required");
	const apiKey = slot.apiKey.trim();
	const probeKey = `${url}|${modelId}`;
	return {
		modelId,
		async describe(request, signal?: AbortSignal): Promise<string> {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (request.native && !nativeVideoRejected.has(probeKey)) {
				try {
					return await postVlm(url, apiKey, vlmVideoRequestBody(modelId, videoDataUrl(request.native)), signal);
				} catch (error) {
					if (signal?.aborted) throw error;
					if (!nativeFallbackError(error)) throw error;
					nativeVideoRejected.add(probeKey);
				}
			}
			const frames = await request.frames();
			if (frames.length === 0) throw new Error("Could not extract video frames for VLM");
			return postVlm(url, apiKey, vlmFrameRequestBody(modelId, frames), signal);
		},
	};
}

export function audioDataUrl(audio: AudioWriteupInput): string {
	const mediaType = AUDIO_MEDIA_TYPES[extname(audio.filename).toLowerCase()];
	if (!mediaType) throw new Error("Audio slot accepts AAC, FLAC, M4A, MP3, OGG, or WAV");
	return `data:${mediaType};base64,${Buffer.from(audio.bytes).toString("base64")}`;
}

/** DashScope Omni treats `input_audio.data` as a URL; raw base64 is rejected. */
export function omniAudioDataUri(audio: AudioWriteupInput): string {
	return `data:;base64,${Buffer.from(audio.bytes).toString("base64")}`;
}

export function inputAudioFormat(filename: string): string {
	const ext = extname(filename).toLowerCase().replace(".", "");
	if (ext === "m4a" || ext === "aac") return "mp3";
	if (INPUT_AUDIO_FORMATS.has(ext)) return ext;
	return "wav";
}

export function shouldFallbackFromAudioUrl(status: number, body: string): boolean {
	if (status === 401 || status === 403) return false;
	if (status === 400 || status === 413 || status === 415 || status === 422) return true;
	if (status >= 500) return true;
	return /audio_url|unsupported.*audio|invalid.*content|unknown.*type|does not support|stream/i.test(body);
}

export function looksLikeHostedOmni(baseUrl: string): boolean {
	return /dashscope|compatible-mode/i.test(baseUrl);
}

export function explainAudioEndpoint(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (!/either 'text' or 'image_url'/i.test(message)) {
		return error instanceof Error ? error : new Error(message);
	}
	return new Error(
		`${message}\nThis Base URL only accepts vision chat parts (text / image_url), not audio. ` +
			"Use a hosted Omni endpoint (DashScope compatible-mode), not LM Studio or the VLM URL.",
	);
}

export function createHttpAudioProvider(slot: {
	baseUrl: string;
	apiKey: string;
	model: string;
}): AudioWriteupProvider {
	const modelId = slot.model.trim();
	const url = modelRequestUrl(slot.baseUrl);
	if (!modelId) throw new Error("Audio model is required");
	const apiKey = slot.apiKey.trim();
	const probeKey = `${url}|${modelId}`;
	const hostedOmni = looksLikeHostedOmni(slot.baseUrl);
	return {
		modelId,
		async describe(audio: AudioWriteupInput, signal?: AbortSignal): Promise<string> {
			const attempts: Array<() => Promise<string>> = hostedOmni
				? [
					() => postChat(url, apiKey, audioOmniRequestBody(modelId, audio), "Audio", signal),
				]
				: [
					() => postChat(url, apiKey, audioUrlRequestBody(modelId, audioDataUrl(audio)), "Audio", signal),
					() => postChat(url, apiKey, audioInputRequestBody(modelId, audio), "Audio", signal),
					() => postChat(url, apiKey, audioOmniRequestBody(modelId, audio), "Audio", signal),
				];
			let lastError: unknown;
			for (const [index, attempt] of attempts.entries()) {
				if (!hostedOmni && index === 0 && audioUrlRejected.has(probeKey)) continue;
				try {
					return await attempt();
				} catch (error) {
					lastError = error;
					if (!audioFallbackError(error)) throw explainAudioEndpoint(error);
					if (!hostedOmni && index === 0) audioUrlRejected.add(probeKey);
				}
			}
			throw explainAudioEndpoint(lastError);
		},
	};
}

export function audioUrlRequestBody(modelId: string, dataUrl: string): Record<string, unknown> {
	return chatBody(modelId, AUDIO_WRITEUP_SYSTEM_PROMPT, [
		{ type: "text", text: AUDIO_WRITEUP_USER_PROMPT },
		{ type: "audio_url", audio_url: { url: dataUrl } },
	]);
}

export function audioInputRequestBody(modelId: string, audio: AudioWriteupInput): Record<string, unknown> {
	return chatBody(modelId, AUDIO_WRITEUP_SYSTEM_PROMPT, [
		{ type: "text", text: AUDIO_WRITEUP_USER_PROMPT },
		{
			type: "input_audio",
			input_audio: {
				data: Buffer.from(audio.bytes).toString("base64"),
				format: inputAudioFormat(audio.filename),
			},
		},
	]);
}

/** Hosted Qwen-Omni (DashScope compatible-mode): data URI, text-only output, stream required. */
export function audioOmniRequestBody(modelId: string, audio: AudioWriteupInput): Record<string, unknown> {
	return {
		...chatBody(modelId, AUDIO_WRITEUP_SYSTEM_PROMPT, [
			{ type: "text", text: AUDIO_WRITEUP_USER_PROMPT },
			{
				type: "input_audio",
				input_audio: {
					data: omniAudioDataUri(audio),
					format: inputAudioFormat(audio.filename),
				},
			},
		]),
		modalities: ["text"],
		stream: true,
		stream_options: { include_usage: true },
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

async function postVlm(
	url: string,
	apiKey: string,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	return postChat(url, apiKey, payload, "VLM", signal);
}

async function postChat(
	url: string,
	apiKey: string,
	payload: Record<string, unknown>,
	kind: "VLM" | "Audio",
	signal?: AbortSignal,
): Promise<string> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
		signal,
	});
	const body = await response.text();
	if (!response.ok) {
		const detail = body.trim().slice(0, 8_000);
		throw new Error(detail
			? `${kind} request failed (${response.status}): ${detail}`
			: `${kind} request failed (${response.status})`);
	}
	if (payload.stream === true) {
		const trimmed = body.trim();
		if (trimmed.startsWith("{")) return parseVlmResponse(trimmed);
		return parseChatSse(body);
	}
	return parseVlmResponse(body);
}

export function parseChatSse(body: string): string {
	const parts: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const data = trimmed.slice(5).trim();
		if (!data || data === "[DONE]") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			continue;
		}
		if (parsed && typeof parsed === "object" && "error" in parsed) {
			throw new Error(`Audio stream error: ${JSON.stringify(parsed)}`);
		}
		const chunk = sseChoiceText(parsed);
		if (chunk) parts.push(chunk);
	}
	const text = parts.join("").trim();
	if (!text) throw new Error("Audio response is missing text");
	return text;
}

function sseChoiceText(parsed: unknown): string {
	if (!parsed || typeof parsed !== "object" || !("choices" in parsed) || !Array.isArray(parsed.choices)) {
		return "";
	}
	const choice = parsed.choices[0];
	if (!choice || typeof choice !== "object") return "";
	if ("delta" in choice) return contentDelta(choice.delta);
	if ("message" in choice) return contentDelta(choice.message);
	return "";
}

function contentDelta(value: unknown): string {
	if (!value || typeof value !== "object" || !("content" in value)) return "";
	const content = value.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			parts.push(part);
			continue;
		}
		if (!part || typeof part !== "object") continue;
		if ("text" in part && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("");
}

function nativeFallbackError(error: unknown): boolean {
	return chatFallbackError(error, shouldFallbackFromNativeVideo);
}

function audioFallbackError(error: unknown): boolean {
	return chatFallbackError(error, shouldFallbackFromAudioUrl);
}

function chatFallbackError(
	error: unknown,
	shouldFallback: (status: number, body: string) => boolean,
): boolean {
	if (!(error instanceof Error)) return false;
	const match = error.message.match(/request failed \((\d+)\)/);
	if (!match) return false;
	const status = Number(match[1]);
	const body = error.message.slice(error.message.indexOf(":") + 1);
	return shouldFallback(status, body);
}

function openaiMessageText(parsed: unknown): string | undefined {
	if (!parsed || typeof parsed !== "object" || !("choices" in parsed) || !Array.isArray(parsed.choices)) {
		return undefined;
	}
	const choice = parsed.choices[0];
	if (!choice || typeof choice !== "object") return undefined;
	if ("message" in choice) {
		const text = contentText(choice.message);
		if (text) return text;
	}
	if ("delta" in choice) return contentText(choice.delta);
	return undefined;
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

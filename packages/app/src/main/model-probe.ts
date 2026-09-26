import type { ModelProbeDraft, ProbeResult } from "../shared/model-settings.ts";
import { embeddingsUrl } from "./embedding-provider.ts";
import { vlmChatUrl } from "./vlm-provider.ts";

const TIMEOUT_MS = 8_000;

export function modelsUrl(baseUrl: string): string {
	return openaiLeafUrl(baseUrl, "models");
}

export function rerankUrl(baseUrl: string): string {
	return openaiLeafUrl(baseUrl, "rerank");
}

export async function probeModelSlot(draft: ModelProbeDraft): Promise<ProbeResult> {
	try {
		const baseUrl = draft.baseUrl.trim();
		const model = draft.model.trim();
		if (!baseUrl) throw new Error("Base URL is required");
		if (!model) throw new Error("Model is required");
		const apiKey = draft.apiKey?.trim() ?? "";
		switch (draft.slot) {
			case "chat":
			case "vlm":
				await probeChatLike(baseUrl, model, apiKey);
				break;
			case "embedding":
				await probeEmbedding(baseUrl, model, apiKey);
				break;
			case "rerank":
				await probeRerank(baseUrl, model, apiKey);
				break;
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function openaiLeafUrl(baseUrl: string, leaf: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (!trimmed) throw new Error("Base URL is required");
	if (trimmed.toLowerCase().endsWith(`/${leaf}`)) return trimmed;
	if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/${leaf}`;
	return `${trimmed}/v1/${leaf}`;
}

async function probeChatLike(baseUrl: string, model: string, apiKey: string): Promise<void> {
	if (await probeModelsList(baseUrl, apiKey)) return;
	await probeJson("POST", vlmChatUrl(baseUrl), apiKey, {
		model,
		max_tokens: 1,
		messages: [{ role: "user", content: "ping" }],
	});
}

async function probeEmbedding(baseUrl: string, model: string, apiKey: string): Promise<void> {
	if (await probeModelsList(baseUrl, apiKey)) return;
	await probeJson("POST", embeddingsUrl(baseUrl), apiKey, { model, input: ["ping"] });
}

async function probeRerank(baseUrl: string, model: string, apiKey: string): Promise<void> {
	if (await probeModelsList(baseUrl, apiKey)) return;
	await probeJson("POST", rerankUrl(baseUrl), apiKey, {
		model,
		query: "ping",
		documents: ["pong"],
	});
}

/** GET /v1/models: 200 JSON is enough. 401/403 fail. Missing route falls through. */
async function probeModelsList(baseUrl: string, apiKey: string): Promise<boolean> {
	const result = await request("GET", modelsUrl(baseUrl), apiKey);
	if (result.status === 401 || result.status === 403) {
		throw httpError(result.status, result.body);
	}
	if (result.status === 200 && looksLikeJson(result.body)) return true;
	if (result.status === 404 || result.status === 405 || result.status === 501) return false;
	if (result.status >= 200 && result.status < 300) return false;
	throw httpError(result.status, result.body);
}

async function probeJson(
	method: "GET" | "POST",
	url: string,
	apiKey: string,
	body?: unknown,
): Promise<void> {
	const result = await request(method, url, apiKey, body);
	if (result.status < 200 || result.status >= 300) throw httpError(result.status, result.body);
	if (!looksLikeJson(result.body)) throw new Error("Response is not JSON");
}

async function request(
	method: "GET" | "POST",
	url: string,
	apiKey: string,
	body?: unknown,
): Promise<{ status: number; body: string }> {
	const headers: Record<string, string> = {};
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	if (body !== undefined) headers["content-type"] = "application/json";
	const response = await fetch(url, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	}).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${method} ${url}: ${message}`);
	});
	return { status: response.status, body: await response.text() };
}

function looksLikeJson(body: string): boolean {
	const trimmed = body.trim();
	if (!trimmed) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

function httpError(status: number, body: string): Error {
	const detail = body.trim();
	return new Error(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
}

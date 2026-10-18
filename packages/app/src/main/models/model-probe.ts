import type { ModelProbeDraft, ProbeResult } from "../../shared/model-settings.ts";
import { createHttpEmbeddingProvider } from "./embedding-provider.ts";
import { createHttpRerankProvider } from "./rerank-provider.ts";
import { modelRequestUrl } from "../../shared/model-request-url.ts";

const TIMEOUT_MS = 8_000;

export async function probeModelSlot(draft: ModelProbeDraft): Promise<ProbeResult> {
	try {
		const requestUrl = modelRequestUrl(draft.requestUrl);
		const model = draft.model.trim();
		if (!model) throw new Error("Model is required");
		const apiKey = draft.apiKey?.trim() ?? "";
		switch (draft.slot) {
			case "vlm":
			case "audio":
				await probeChatLike(requestUrl, model, apiKey);
				break;
			case "embedding":
				await probeEmbedding(requestUrl, model, apiKey);
				break;
			case "rerank":
				await probeRerank(requestUrl, model, apiKey);
				break;
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

// A tiny text request checks the exact endpoint, not image/audio capability.
async function probeChatLike(requestUrl: string, model: string, apiKey: string): Promise<void> {
	await probeJson("POST", requestUrl, apiKey, {
		model,
		max_tokens: 1,
		messages: [{ role: "user", content: "ping" }],
	});
}

async function probeEmbedding(requestUrl: string, model: string, apiKey: string): Promise<void> {
	await createHttpEmbeddingProvider({ requestUrl, apiKey, model }).embed(["ping"], AbortSignal.timeout(TIMEOUT_MS));
}

async function probeRerank(requestUrl: string, model: string, apiKey: string): Promise<void> {
	await createHttpRerankProvider({ requestUrl, apiKey, model }).rerank("ping", ["pong"], AbortSignal.timeout(TIMEOUT_MS));
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

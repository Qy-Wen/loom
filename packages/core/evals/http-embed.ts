import { createHttpEmbeddingProvider as createRequestUrlProvider } from "@loom/core/embedding";
import type { EmbeddingProvider } from "../src/model/text-embed.ts";

export function embeddingsUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (!trimmed) throw new Error("Embedding base URL is required");
	if (trimmed.endsWith("/embeddings")) return trimmed;
	if (/\/v\d+$/.test(trimmed)) return `${trimmed}/embeddings`;
	return `${trimmed}/v1/embeddings`;
}

export function embeddingFromEnv(env: NodeJS.ProcessEnv = process.env): {
	baseUrl: string;
	apiKey: string;
	model: string;
} | undefined {
	const baseUrl = env.LOOM_EMBED_BASE_URL?.trim();
	const model = env.LOOM_EMBED_MODEL?.trim();
	if (!baseUrl || !model) return undefined;
	return { baseUrl, model, apiKey: env.LOOM_EMBED_API_KEY?.trim() ?? "" };
}

export function createHttpEmbeddingProvider(slot: {
	baseUrl: string;
	apiKey: string;
	model: string;
}): EmbeddingProvider {
	return createRequestUrlProvider({ ...slot, requestUrl: embeddingsUrl(slot.baseUrl) });
}

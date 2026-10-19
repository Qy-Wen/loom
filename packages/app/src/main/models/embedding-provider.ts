import { createHttpEmbeddingProvider as createRequestUrlProvider } from "@loom/core/embedding";
import type { EmbeddingProvider } from "@loom/core";
import { modelRequestUrl } from "../../shared/model-request-url.ts";

export function createHttpEmbeddingProvider(slot: {
	requestUrl: string;
	apiKey: string;
	model: string;
}): EmbeddingProvider {
	return createRequestUrlProvider({ ...slot, requestUrl: modelRequestUrl(slot.requestUrl) });
}

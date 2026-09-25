import type { EmbeddingProvider } from "@loom/core";

export function embeddingsUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (!trimmed) throw new Error("Embedding base URL is required");
	if (trimmed.endsWith("/embeddings")) return trimmed;
	if (/\/v\d+$/.test(trimmed)) return `${trimmed}/embeddings`;
	return `${trimmed}/v1/embeddings`;
}

export function createHttpEmbeddingProvider(slot: {
	baseUrl: string;
	apiKey: string;
	model: string;
}): EmbeddingProvider {
	const modelId = slot.model.trim();
	const url = embeddingsUrl(slot.baseUrl);
	if (!modelId) throw new Error("Embedding model is required");
	const apiKey = slot.apiKey.trim();
	return {
		modelId,
		async embed(texts: string[]): Promise<number[][]> {
			if (texts.length === 0) return [];
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (apiKey) headers.authorization = `Bearer ${apiKey}`;
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({ model: modelId, input: texts }),
			});
			const body = await response.text();
			if (!response.ok) {
				throw new Error(`Embedding request failed (${response.status}): ${body.slice(0, 240)}`);
			}
			return parseEmbeddingResponse(body, texts.length);
		},
	};
}

export function parseEmbeddingResponse(body: string, expected: number): number[][] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("Embedding response is not JSON");
	}
	if (!parsed || typeof parsed !== "object" || !("data" in parsed) || !Array.isArray(parsed.data)) {
		throw new Error("Embedding response is missing data");
	}
	const rows = [...parsed.data].sort((left, right) => indexOf(left) - indexOf(right));
	if (rows.length !== expected) {
		throw new Error("Embedding provider returned the wrong number of vectors");
	}
	return rows.map((row, index) => readEmbedding(row, index));
}

function indexOf(row: unknown): number {
	if (row && typeof row === "object" && "index" in row && typeof row.index === "number") return row.index;
	return 0;
}

function readEmbedding(row: unknown, index: number): number[] {
	if (!row || typeof row !== "object" || !("embedding" in row)) {
		throw new Error(`Embedding response item ${index} is missing embedding`);
	}
	const value = row.embedding;
	if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
		return value;
	}
	if (typeof value === "string") {
		const buffer = Buffer.from(value, "base64");
		return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4)));
	}
	throw new Error(`Embedding response item ${index} has an unsupported vector`);
}

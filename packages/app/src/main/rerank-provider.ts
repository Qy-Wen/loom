import type { RerankProvider } from "@loom/core";
import { modelRequestUrl } from "../shared/model-request-url.ts";

export function looksLikeBailian(baseUrl: string): boolean {
	return /dashscope|compatible-mode|compatible-api|\.maas\.aliyuncs\.com/i.test(baseUrl);
}

export function usesBailianNativeRerank(model: string): boolean {
	return /gte-rerank|qwen3\.7-text-rerank|qwen3-vl-rerank/i.test(model);
}

export function createHttpRerankProvider(slot: {
	baseUrl: string;
	apiKey: string;
	model: string;
}): RerankProvider {
	const modelId = slot.model.trim();
	if (!modelId) throw new Error("Rerank model is required");
	const apiKey = slot.apiKey.trim();
	const native = looksLikeBailian(slot.baseUrl) && usesBailianNativeRerank(modelId);
	const url = modelRequestUrl(slot.baseUrl);
	return {
		modelId,
		async rerank(query: string, documents: string[], signal?: AbortSignal): Promise<number[]> {
			if (documents.length === 0) return [];
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (apiKey) headers.authorization = `Bearer ${apiKey}`;
			const payload = native
				? {
					model: modelId,
					input: { query, documents },
					parameters: { top_n: documents.length },
				}
				: {
					model: modelId,
					query,
					documents,
					top_n: documents.length,
				};
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal,
			});
			const body = await response.text();
			if (!response.ok) {
				console.log(`[loom:rerank] ${response.status} ${url} model=${modelId} docs=${documents.length}`);
				throw new Error(`Rerank request failed (${response.status}): ${body.trim().slice(0, 8_000)}`);
			}
			const scores = parseRerankResponse(body, documents.length);
			console.log(`[loom:rerank] ${response.status} ${url} model=${modelId} docs=${documents.length}`);
			console.log(`[loom:rerank] results ${formatRerankResults(body, documents, scores)}`);
			return scores;
		},
	};
}

export function parseRerankResponse(body: string, expected: number): number[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("Rerank response is not JSON");
	}
	const rows = rerankRows(parsed);
	if (rows.length === 0) throw new Error("Rerank response is missing results");
	const scores = Array.from({ length: expected }, () => Number.NEGATIVE_INFINITY);
	for (const row of rows) {
		if (row.index < 0 || row.index >= expected) continue;
		scores[row.index] = row.score;
	}
	if (scores.every((score) => score === Number.NEGATIVE_INFINITY)) {
		throw new Error("Rerank response has no scores in range");
	}
	return scores;
}

function formatRerankResults(body: string, documents: string[], scores: number[]): string {
	const ranked = scores
		.map((score, index) => ({
			index,
			score,
			text: (documents[index] ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
		}))
		.sort((left, right) => right.score - left.score || left.index - right.index);
	let raw = "";
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === "object") {
			const list = resultsList(parsed);
			if (list) raw = JSON.stringify(list);
		}
	} catch {
		raw = "";
	}
	return raw ? `${raw} ranked=${JSON.stringify(ranked)}` : JSON.stringify(ranked);
}

function rerankRows(parsed: unknown): Array<{ index: number; score: number }> {
	if (!parsed || typeof parsed !== "object") return [];
	const list = resultsList(parsed);
	if (!list) return [];
	const rows: Array<{ index: number; score: number }> = [];
	list.forEach((item, fallbackIndex) => {
		if (!item || typeof item !== "object") return;
		const index = "index" in item && typeof item.index === "number" ? item.index : fallbackIndex;
		const score = relevanceScore(item);
		if (score === undefined) return;
		rows.push({ index, score });
	});
	return rows;
}

function resultsList(parsed: object): unknown[] | undefined {
	if ("results" in parsed && Array.isArray(parsed.results)) return parsed.results;
	if ("data" in parsed && Array.isArray(parsed.data)) return parsed.data;
	if (
		"output" in parsed
		&& parsed.output
		&& typeof parsed.output === "object"
		&& "results" in parsed.output
		&& Array.isArray(parsed.output.results)
	) {
		return parsed.output.results;
	}
	return undefined;
}

function relevanceScore(item: object): number | undefined {
	if ("relevance_score" in item && typeof item.relevance_score === "number") return item.relevance_score;
	if ("score" in item && typeof item.score === "number") return item.score;
	return undefined;
}

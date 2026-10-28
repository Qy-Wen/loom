import { postJson } from "./http.ts";
import type { WebProvider } from "./types.ts";

const BASE_URL = "https://api.deepseek.com";

interface SearchResponse {
	results?: Array<{ title?: string; url?: string; summary?: string; snippet?: string; site_name?: string | null; date?: string | null }>;
}

/** DeepSeek's own search engine and page fetcher, with the same bearer key as its Chat API. */
export const deepSeekWebProvider: WebProvider = {
	id: "deepseek",
	name: "DeepSeek",
	chatProviderId: "deepseek",
	limits: { query: 128, count: 50 },
	searchSyntax: "site:, -site:, \"exact phrase\", -word, lang:zh,en, after:2025-01-01, before:2026-06-01",
	async search({ query, count }, call) {
		// need_content stays off: summaries are written for models, and full pages are what fetchPage is for.
		const data = await postJson(`${BASE_URL}/v1/tools/search`, call.apiKey, { query, count, need_content: false }, call) as SearchResponse;
		return (Array.isArray(data.results) ? data.results : []).map((row) => ({
			title: row.title ?? "",
			url: row.url ?? "",
			summary: row.summary || row.snippet || "",
			...(row.site_name ? { site: row.site_name } : {}),
			...(row.date ? { date: row.date } : {}),
		}));
	},
	async fetchPage(url, call) {
		const page = await postJson(`${BASE_URL}/v1/tools/fetch`, call.apiKey, { url }, call) as { title?: string; content?: string };
		return { title: page.title ?? "", content: page.content ?? "" };
	},
};

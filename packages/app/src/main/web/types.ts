/** One search hit, in the shape every provider maps to. */
export interface WebSearchResult {
	title: string;
	url: string;
	/** Text written for a model to read. */
	summary: string;
	site?: string;
	/** ISO date or date-time, when the provider knows it. */
	date?: string;
}

export interface WebPage {
	title: string;
	/** Markdown or plain text. */
	content: string;
}

/** What a provider needs for one call. The key is read per call, so a rotated key applies at once. */
export interface WebCall {
	apiKey: string;
	signal?: AbortSignal;
	/** Replaced in tests. */
	fetch?: typeof fetch;
}

/**
 * A cloud vendor that offers web search, and optionally page fetch, behind the API key it already uses for Chat.
 * Add a vendor by implementing this and listing it in `WEB_PROVIDERS`; the tools, approval rules, and Settings switch are shared.
 */
export interface WebProvider {
	readonly id: string;
	readonly name: string;
	/** Chat provider whose API key this vendor accepts. */
	readonly chatProviderId: string;
	readonly limits: { query: number; count: number };
	/** Operators the search box understands, shown to the model. Omit when there are none. */
	readonly searchSyntax?: string;
	search(request: { query: string; count: number }, call: WebCall): Promise<WebSearchResult[]>;
	/** Absent when the vendor only searches; then `web_fetch` is not offered. */
	fetchPage?(url: string, call: WebCall): Promise<WebPage>;
}

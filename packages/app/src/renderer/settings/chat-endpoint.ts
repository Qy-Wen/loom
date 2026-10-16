import { validateChatBaseUrl, type ChatApi } from "@loom/agent/chat-models";

export type ChatEndpoint = { api: ChatApi; baseUrl: string; modelId?: string };
export type ChatEndpointErrorCode = "url" | "protocol" | "query";
export class ChatEndpointError extends Error {
	readonly code: ChatEndpointErrorCode;
	constructor(code: ChatEndpointErrorCode) { super(code); this.code = code; }
}

/** Recognize SDK operation paths, then hand only their prefix back to pi-ai. No network probing. */
export function parseChatEndpoint(value: string): ChatEndpoint {
	let url: URL;
	try { url = new URL(value.trim()); } catch { throw new ChatEndpointError("url"); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new ChatEndpointError("url");
	let api: ChatApi;
	let suffix: string;
	let modelId: string | undefined;
	const path = url.pathname;
	if (path.endsWith("/chat/completions")) { api = "openai-completions"; suffix = "/chat/completions"; }
	else if (path.endsWith("/responses")) { api = "openai-responses"; suffix = "/responses"; }
	else if (path.endsWith("/v1/messages")) { api = "anthropic-messages"; suffix = "/v1/messages"; }
	else {
		const google = path.match(/\/models\/([^/]+):streamGenerateContent$/);
		if (!google) throw new ChatEndpointError("protocol");
		api = "google-generative-ai"; suffix = google[0];
		try { modelId = decodeURIComponent(google[1]!); } catch { throw new ChatEndpointError("url"); }
	}
	// Native SDKs own these flags. Reject other query parameters instead of silently dropping them.
	for (const [key, value] of url.searchParams) {
		if (api === "anthropic-messages" && key === "beta" && value === "true") continue;
		if (api === "google-generative-ai" && key === "alt" && value === "sse") continue;
		throw new ChatEndpointError("query");
	}
	url.pathname = path.slice(0, -suffix.length);
	url.search = "";
	const baseUrl = url.toString().replace(/\/+$/, "");
	validateChatBaseUrl(baseUrl);
	return { api, baseUrl, ...(modelId ? { modelId } : {}) };
}

export function detectChatEndpoint(value: string): ChatEndpoint | undefined {
	try { return parseChatEndpoint(value); } catch { return undefined; }
}

/** Reconstruct the editable full operation URL from pi-ai's native provider configuration. */
export function chatEndpointUrl(baseUrl: string, api: ChatApi, modelId?: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	switch (api) {
		case "openai-completions": return `${base}/chat/completions`;
		case "openai-responses": return `${base}/responses`;
		case "anthropic-messages": return `${base}/v1/messages?beta=true`;
		case "google-generative-ai": return `${base}/models/${encodeURIComponent(modelId?.replace(/^models\//, "") ?? "model-id")}:streamGenerateContent?alt=sse`;
	}
}

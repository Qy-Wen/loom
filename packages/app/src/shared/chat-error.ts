/** AG-UI assistant message ids for Chat HTTP/config failures, not model text. */
export const CHAT_ERROR_ID_PREFIX = "loom-error-";

export function isChatErrorMessageId(id: string | undefined): boolean {
	return Boolean(id?.startsWith(CHAT_ERROR_ID_PREFIX));
}

export function formatChatError(cause: unknown): string {
	const raw = cause instanceof Error ? cause.message : String(cause);
	if (/Chat is not configured/i.test(raw)) {
		return "Set a base URL and model in Settings.";
	}
	if (/401|unauthorized|invalid api key|incorrect api key|authentication/i.test(raw)) {
		return `API key was rejected. Check the Chat key in Settings.\n${raw}`;
	}
	if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_|socket hang up|network/i.test(raw)) {
		return `Could not reach the Chat endpoint. Check the network connection and the base URL in Settings.\n${raw.trim()}`;
	}
	return raw.trim() || "The Chat endpoint did not return a reply.";
}

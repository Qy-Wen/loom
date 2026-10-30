/** AG-UI assistant message ids for Chat HTTP/config failures, not model text. */
export const CHAT_ERROR_ID_PREFIX = "loom-error-";

export function isChatErrorMessageId(id: string | undefined): boolean {
	return Boolean(id?.startsWith(CHAT_ERROR_ID_PREFIX));
}

const KEY_REJECTED = "API key was rejected. Check the Chat key in Settings.";
const UNREACHABLE = "Could not reach the Chat endpoint. Check the network connection and the base URL in Settings.";

/** Explain a Chat failure. Already-formatted text passes through, so formatting twice is harmless. */
export function formatChatError(cause: unknown): string {
	const raw = cause instanceof Error ? cause.message : String(cause);
	if (raw.startsWith(KEY_REJECTED) || raw.startsWith(UNREACHABLE)) return raw.trim();
	if (/Chat is not configured/i.test(raw)) {
		return "Set a base URL and model in Settings.";
	}
	if (/401|unauthorized|invalid api key|incorrect api key|authentication/i.test(raw)) {
		return `${KEY_REJECTED}\n${raw}`;
	}
	if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_|socket hang up|network/i.test(raw)) {
		return `${UNREACHABLE}\n${raw.trim()}`;
	}
	return raw.trim() || "The Chat endpoint did not return a reply.";
}

/**
 * The live error is the same failure as the history's last row once that row is an error with the same text.
 * Until the history catches up the live copy shows; it then gives way, so one failure is drawn once.
 */
export function failureShownInHistory(messages: readonly { id?: string; content?: unknown }[], failure: string | null): boolean {
	if (failure === null) return false;
	const last = messages.at(-1);
	return Boolean(last && isChatErrorMessageId(last.id) && typeof last.content === "string" && last.content.trim() === formatChatError(failure));
}

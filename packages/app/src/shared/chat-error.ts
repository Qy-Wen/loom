/** AG-UI assistant message ids for Chat HTTP/config failures, not model text. */
export const CHAT_ERROR_ID_PREFIX = "loom-error-";

export function isChatErrorMessageId(id: string | undefined): boolean {
	return Boolean(id?.startsWith(CHAT_ERROR_ID_PREFIX));
}

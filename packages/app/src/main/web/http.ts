/** POST JSON with a bearer key, a timeout, and failures rewritten as advice a model can act on. */
export async function postJson(url: string, apiKey: string, body: unknown, options: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<unknown> {
	options.signal?.throwIfAborted();
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(url, {
			method: "POST",
			headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
		});
	} catch (error) {
		options.signal?.throwIfAborted();
		if (timeout.aborted) throw new Error("The web request timed out. Retrying later may work.");
		throw new Error(`The web request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const raw = await response.text();
	if (!response.ok) throw new Error(httpFailure(response.status, raw));
	try { return JSON.parse(raw); } catch { throw new Error("The web service returned an unreadable response"); }
}

/** Plain-language reason for a failed call, saying whether a retry can help. Never includes the key. */
export function httpFailure(status: number, raw: string): string {
	let detail = "";
	try {
		const error = (JSON.parse(raw) as { error?: { message?: unknown } | string }).error;
		detail = typeof error === "string" ? error : String(error?.message ?? "");
	} catch { /* Body is not JSON. */ }
	const reason: Record<number, string> = {
		400: "The request was invalid. Change it before retrying.",
		401: "The API key is missing or invalid. Check it in Settings → Models.",
		402: "The account balance is too low. Top up, then retry.",
		403: "The request was refused by the service's policy. Do not retry it.",
		404: "Nothing usable was found: unavailable, blocked, an unsupported type, or no readable text. Do not retry the same input.",
		408: "The request timed out. Retrying later may work.",
		413: "The request was too large.",
		429: "Rate limit reached. Wait a moment, then retry.",
	};
	const base = reason[status] ?? (status >= 500 ? "The service had an error. Retrying later may work." : "The request was rejected.");
	return `Web request failed (HTTP ${status}). ${base}${detail ? ` Detail: ${detail.slice(0, 300)}` : ""}`;
}

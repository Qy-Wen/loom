/** Validate an exact non-Chat request URL. Never infer a version or append/rewrite a path. */
export function modelRequestUrl(value: string): string {
	const url = value.trim();
	if (!url) throw new Error("Request URL is required");
	let parsed: URL;
	try { parsed = new URL(url); } catch { throw new Error("Request URL must be an HTTP(S) URL"); }
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Request URL must be an HTTP(S) URL");
	if (parsed.username || parsed.password || parsed.hash) throw new Error("Request URL must not contain credentials or a fragment");
	return url;
}

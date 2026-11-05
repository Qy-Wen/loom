export interface MediaDescription {
	caption: string;
	tags: string[];
	transcript?: string | null;
}

/** Validate model output before it becomes a saved description or a tag suggestion. */
export function parseMediaDescriptionJson(raw: string, audio = false): MediaDescription {
	let value: unknown;
	try { value = JSON.parse(stripJsonFence(raw)); }
	catch { throw new Error("Description model must return a JSON object"); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Description must be an object");
	const data = value as Record<string, unknown>;
	if (typeof data.caption !== "string" || !data.caption.trim()) throw new Error("Description caption must be non-empty text");
	if (!Array.isArray(data.tags) || data.tags.some((tag) => typeof tag !== "string" || !tag.trim() || /[\r\n]/.test(tag))) {
		throw new Error("Description tags must be an array of non-empty, single-line strings");
	}
	if ((audio || "transcript" in data) && data.transcript !== null && typeof data.transcript !== "string") {
		throw new Error("Audio transcript must be text or null");
	}
	return {
		caption: data.caption.trim(),
		tags: uniqueDescriptionTags(data.tags as string[]),
		...(audio || "transcript" in data ? { transcript: typeof data.transcript === "string" ? data.transcript.trim() || null : null } : {}),
	};
}

/** Many models wrap JSON in a ```json fence despite instructions; accept only a single wrapping fence. */
function stripJsonFence(raw: string): string {
	const match = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(raw);
	return match ? match[1] : raw;
}

/** Derive searchable text from structured fields; never use it as the stored description. */
export function mediaDescriptionMarkdown(description: MediaDescription): string {
	return `## Caption\n${description.caption}\n`
		+ (description.tags.length ? `\n## Tags\n${description.tags.map((tag) => `- ${tag}`).join("\n")}\n` : "")
		+ (description.transcript ? `\n## Transcript\n${description.transcript}\n` : "");
}

export function uniqueDescriptionTags(tags: string[]): string[] {
	const unique = new Map<string, string>();
	for (const value of tags) {
		const tag = value.trim();
		if (tag && !unique.has(tag.toLowerCase())) unique.set(tag.toLowerCase(), tag);
	}
	return [...unique.values()];
}

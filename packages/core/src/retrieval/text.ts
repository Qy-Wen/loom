import type { AssetEnrichment, EnrichmentData } from "../model/enrichment.ts";

/** String extracts from a ready Level 1 row. Kind, numbers, and errors stay out. */
export function searchableEnrichmentTexts(record: AssetEnrichment | undefined): string[] {
	if (record?.status !== "ready" || !record.data) return [];
	return extractTexts(record.data);
}

/** One FTS document: filename, path, property values, and Level 1 extracts. */
export function searchDocument(
	filename: string,
	relativePath: string,
	propertyValues: Array<string | number | boolean>,
	enrichment?: AssetEnrichment,
	extraText?: string,
): string {
	return [
		filename,
		relativePath,
		...propertyValues.map(String),
		...searchableEnrichmentTexts(enrichment),
		extraText?.trim() ?? "",
	].filter((part) => part.length > 0).join("\n");
}

export function searchTokens(raw: string): string[] {
	return raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** FTS5 MATCH: quoted prefix tokens ANDed. Empty after tokenize means no match. */
export function compileFtsQuery(raw: string): string | undefined {
	const tokens = searchTokens(raw);
	if (tokens.length === 0) return undefined;
	return tokens.map((token) => `"${token.replaceAll("\"", "")}"*`).join(" AND ");
}

export function documentMatchesTokens(document: string, tokens: string[]): boolean {
	if (tokens.length === 0) return false;
	const haystack = document.toLowerCase();
	return tokens.every((token) => haystack.includes(token));
}

function extractTexts(data: EnrichmentData): string[] {
	if (data.kind === "text") return [data.text];
	if (data.kind === "image") return [data.camera, data.capturedAt].filter((value) => value !== undefined);
	if (data.kind === "video") return [data.videoCodec, data.audioCodec].filter((value) => value !== undefined);
	return data.audioCodec ? [data.audioCodec] : [];
}

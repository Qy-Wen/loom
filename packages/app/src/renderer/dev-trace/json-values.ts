import { traceBlobReference } from "@loom/agent/trace-blob";

export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export const JSON_STRING_PREVIEW = 600;

export function parseTraceJson(text: string): { kind: "json"; value: JsonValue } | { kind: "text" } {
	try { return { kind: "json", value: JSON.parse(text) as JsonValue }; }
	catch { return { kind: "text" }; }
}

/** JSON Pointer provides stable, unambiguous identity even for keys containing slashes or tildes. */
export function jsonPath(parent: string, key: string): string {
	return `${parent}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

export function jsonEntries(value: JsonValue): [string, JsonValue][] {
	if (value === null || typeof value !== "object") return [];
	return Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
}

export function jsonString(value: string, blobs?: Readonly<Record<string, string>>): { text: string; preview: string; missing: boolean; expandable: boolean } {
	const reference = traceBlobReference(value);
	if (reference) {
		const full = blobs?.[reference.hash];
		return { text: full ?? reference.preview, preview: reference.preview, missing: full === undefined, expandable: full !== undefined };
	}
	return { text: value, preview: value.length > JSON_STRING_PREVIEW ? `${value.slice(0, JSON_STRING_PREVIEW)}…` : value, missing: false, expandable: value.length > JSON_STRING_PREVIEW };
}

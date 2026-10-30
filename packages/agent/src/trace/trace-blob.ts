/** Preview marker for a long text inside a recorded model request; no Node imports, so the trace window can use it. */
export function traceBlobMark(hash: string, length: number): string {
	return `⟦blob:${hash}:${length}⟧`;
}

/** Resolve the marker suffix of a parsed JSON string without treating embedded JSON as an object. */
export function traceBlobReference(value: string): { hash: string; length: number; preview: string } | undefined {
	const match = value.match(/^(.*)… ⟦blob:([0-9a-f]{16}):(\d+)⟧$/s);
	return match ? { hash: match[2]!, length: Number(match[3]), preview: `${match[1]}…` } : undefined;
}

export type TraceTextPart = { readonly text: string } | {
	readonly hash: string;
	readonly length: number;
	/** Includes the surrounding JSON quotes; replaced as a whole on expansion. Absent for a bare marker. */
	readonly previewJson?: string;
};

/** Keep each JSON preview and its marker together, so expansion replaces rather than appends to the preview. */
export function splitTraceBlobs(text: string): TraceTextPart[] {
	const parts: TraceTextPart[] = [];
	let last = 0;
	for (const match of text.matchAll(/"((?:[^"\\]|\\.)*?)… ⟦blob:([0-9a-f]{16}):(\d+)⟧"|⟦blob:([0-9a-f]{16}):(\d+)⟧/g)) {
		if (match.index > last) parts.push({ text: text.slice(last, match.index) });
		parts.push(match[2] !== undefined
			? { hash: match[2], length: Number(match[3]), previewJson: `"${match[1]}…"` }
			: { hash: match[4]!, length: Number(match[5]) });
		last = match.index + match[0].length;
	}
	if (last < text.length) parts.push({ text: text.slice(last) });
	return parts;
}

/** Preview marker for a long text inside a recorded model request; no Node imports, so the trace window can use it. */
export function traceBlobMark(hash: string, length: number): string {
	return `⟦blob:${hash}:${length}⟧`;
}

export type TraceTextPart = { readonly text: string } | { readonly hash: string; readonly length: number };

/** Split recorded text into plain parts and references to full texts in the record's `blobs`. */
export function splitTraceBlobs(text: string): TraceTextPart[] {
	const parts: TraceTextPart[] = [];
	let last = 0;
	for (const match of text.matchAll(/⟦blob:([0-9a-f]{16}):(\d+)⟧/g)) {
		if (match.index > last) parts.push({ text: text.slice(last, match.index) });
		parts.push({ hash: match[1]!, length: Number(match[2]) });
		last = match.index + match[0].length;
	}
	if (last < text.length) parts.push({ text: text.slice(last) });
	return parts;
}

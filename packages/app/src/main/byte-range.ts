export interface ByteRange {
	start: number;
	end: number;
}

/**
 * Parse the single-range subset needed by Chromium media elements.
 * Multiple or invalid ranges return null and are served as a normal full response.
 */
export function parseByteRange(value: string | null, size: number): ByteRange | null {
	const match = value?.match(/^bytes=(\d*)-(\d*)$/);
	if (!match) return null;

	let start: number;
	let end: number;
	if (match[1]) {
		start = Number(match[1]);
		end = match[2] ? Number(match[2]) : size - 1;
	} else {
		const suffixLength = Number(match[2]);
		if (!suffixLength) return null;
		start = Math.max(0, size - suffixLength);
		end = size - 1;
	}

	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		start >= size ||
		end < start
	) {
		return null;
	}
	return { start, end: Math.min(end, size - 1) };
}

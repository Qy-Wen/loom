/**
 * Full-text tokenizing shared by the file-level and chunk-level indexes.
 *
 * FTS5's own tokenizers treat a run of Chinese as one word, so a query can only
 * match from the start of that run. Instead of swapping the tokenizer, text is
 * segmented with `Intl.Segmenter` and the words are joined with spaces before
 * it reaches `unicode61`. A query is segmented the same way, and each CJK run
 * becomes one phrase so word order and adjacency hold.
 */

/** Han, kana, hangul, and the prolonged sound mark (which belongs to no script). */
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc`;
const CJK_RUN = new RegExp(`[${CJK}]+`, "gu");
/** Letters and digits that are not CJK: `\p{L}` also covers Han, so it has to be carved out. */
const QUERY_PART = new RegExp(`([${CJK}]+)|((?:(?![${CJK}])[\\p{L}\\p{N}])+)`, "gu");
const TOKEN = new RegExp(`(?:(?![${CJK}])[\\p{L}\\p{N}])+|[${CJK}]+`, "gu");

let segmenter: Intl.Segmenter | undefined;

function wordsOf(run: string): string[] {
	segmenter ??= new Intl.Segmenter("zh", { granularity: "word" });
	const words: string[] = [];
	for (const part of segmenter.segment(run)) {
		if (part.isWordLike) words.push(part.segment);
	}
	// Never lose text: a run the segmenter returns nothing for stays whole.
	return words.length > 0 ? words : [run];
}

/**
 * Version of this tokenizing, stored with the index. A change in the rules or in
 * the runtime's ICU dictionary changes how text is cut, so an index built under
 * another version no longer matches new queries and is rebuilt.
 */
export const FTS_FORMAT_VERSION = 1;

export function ftsFormat(): string {
	return `${FTS_FORMAT_VERSION}:icu${process.versions.icu ?? "unknown"}`;
}

/** Text as it is written into an FTS table: each CJK run becomes space-separated words. */
export function segmentForIndex(text: string): string {
	return text.replace(CJK_RUN, (run) => ` ${wordsOf(run).join(" ")} `);
}

interface QueryPart {
	kind: "word" | "phrase";
	text: string;
}

/**
 * Pieces of a query, all ANDed: a run of letters or digits is a prefix word, and a
 * run of CJK is a phrase of its segmented words. Whitespace separates pieces, so
 * `天气 北京` is two phrases, not one.
 */
function queryParts(raw: string): QueryPart[] {
	const parts: QueryPart[] = [];
	for (const match of raw.toLowerCase().matchAll(QUERY_PART)) {
		if (match[1] !== undefined) parts.push({ kind: "phrase", text: wordsOf(match[1]).join(" ") });
		else if (match[2] !== undefined) parts.push({ kind: "word", text: match[2] });
	}
	return parts;
}

/** FTS5 MATCH expression, or undefined when the query has nothing to search for. */
export function compileFtsQuery(raw: string): string | undefined {
	const parts = queryParts(raw);
	if (parts.length === 0) return undefined;
	return parts
		.map((part) => (part.kind === "phrase" ? `"${part.text}"` : `"${part.text}"*`))
		.join(" AND ");
}

/**
 * The same match FTS5 would make, for stores that do not use it: every word is a
 * token prefix and every phrase is a run of adjacent tokens.
 */
export function documentMatchesQuery(document: string, raw: string): boolean {
	const parts = queryParts(raw);
	if (parts.length === 0) return false;
	const tokens = segmentForIndex(document).toLowerCase().match(TOKEN) ?? [];
	const padded = ` ${tokens.join(" ")} `;
	return parts.every((part) => (
		part.kind === "phrase"
			? padded.includes(` ${part.text} `)
			: tokens.some((token) => token.startsWith(part.text))
	));
}

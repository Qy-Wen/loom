import type { EmbeddingProvider } from "../src/model/text-embed.ts";

/**
 * Query-side paraphrases live on these axes. Gold files must not use those
 * paraphrase words; distractors must not hit the gold file's axis.
 */
const AXES = [
	/bicycle|two-wheeled|waterfront|pier/i,
	/soup|basil|broth|herbs|red-fruit/i,
	/aurora|brand|palette|identity/i,
	/hero|establishing|landscape|evening/i,
	/invoice|billing|payment|lamps/i,
	/motorcycle|dented|garage/i,
	/canoe|boathouse|muddy/i,
	/stew|carrots|potatoes/i,
] as const;

function vector(text: string): number[] {
	return AXES.map((axis) => (axis.test(text) ? 1 : 0));
}

/** Keyword axes so semantic qrels work without a live embedding slot. */
export function evalEmbeddingProvider(): EmbeddingProvider {
	return {
		modelId: "eval-embed",
		async embed(texts: string[]) {
			return texts.map(vector);
		},
	};
}

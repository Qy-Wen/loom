export interface RerankProvider {
	modelId: string;
	/** Relevance scores aligned to `documents`. Higher is better. */
	rerank(query: string, documents: string[]): Promise<number[]>;
}

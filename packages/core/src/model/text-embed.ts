export const CHILD_TOKEN_LIMIT = 512;
export const CHILD_TOKEN_OVERLAP = 64;
export const PARENT_TOKEN_LIMIT = 2048;
/**
 * Bytes of a text file the index reads. Chunking is synchronous, about 2 s per MiB.
 * The index reads the original file itself, so this is independent of the smaller
 * extract kept for previews and simple search.
 */
export const TEXT_INDEX_LIMIT = 1024 * 1024;
/** Hosted embeddings (DashScope v4, Qianfan) cap a request at 10–16 inputs. */
export const EMBED_BATCH_SIZE = 8;

export type TextChunkRole = "parent" | "child";
export type TextEmbedJobStatus = "embedding" | "ready" | "failed";
export type TextEmbedStatusKind = "idle" | TextEmbedJobStatus;

export interface EmbeddingProvider {
	modelId: string;
	embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface TextEmbedJob {
	assetId: string;
	status: TextEmbedJobStatus;
	modelId?: string;
	sourceModifiedAt: number;
	error?: string;
	childCount: number;
	parentCount: number;
	updatedAt: number;
}

export interface StoredTextChunk {
	chunkId: string;
	assetId: string;
	parentId: string | null;
	role: TextChunkRole;
	startOffset: number;
	endOffset: number;
	text: string;
	tokenCount: number;
	embedding?: number[];
	modelId?: string;
}

export interface TextEmbedStatus {
	assetId: string;
	status: TextEmbedStatusKind;
	stale: boolean;
	supported: boolean;
	modelId?: string;
	sourceModifiedAt?: number;
	error?: string;
	childCount: number;
	parentCount: number;
	/** The file is longer than `TEXT_INDEX_LIMIT`, so the tail is not indexed. */
	truncated?: boolean;
}

export const CHILD_TOKEN_LIMIT = 512;
export const CHILD_TOKEN_OVERLAP = 64;
export const PARENT_TOKEN_LIMIT = 2048;
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
}

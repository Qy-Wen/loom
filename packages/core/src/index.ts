// Public library API. Storage and service implementations stay internal.
// HTTP embedding, grading helpers, and process sandboxing have separate package entry points.
export { LocalCore } from "./local-core.ts";
export { LibraryPaths } from "./library/paths.ts";
export { resolveMediaBinary, tryResolveMediaBinaries } from "./media/binaries.ts";
export type { MediaProgram } from "./media/binaries.ts";

export type { Asset, AssetType, LibraryChange, LibrarySnapshot } from "./model/asset.ts";
export type { AssetTag, Tag } from "./model/tag.ts";
export type { AssetRelation } from "./model/relation.ts";
export type {
	AssetPropertyValue,
	PropertyDefinition,
	PropertySnapshot,
	PropertyType,
	PropertyValue,
} from "./model/property.ts";
export type {
	AssetEnrichment,
	AudioEnrichmentData,
	EnrichmentData,
	EnrichmentStatus,
	ImageEnrichmentData,
	TextEnrichmentData,
	VideoEnrichmentData,
} from "./model/enrichment.ts";
export type {
	AssetDetailResult,
	AssetLinkView,
	AssetPropertyFilter,
	AssetPropertyView,
	AssetRelationsResult,
	AssetRelationView,
	AssetSearchItem,
	AssetSearchQuery,
	AssetSearchResult,
	DeepSearchResult,
	PropertyFilterOperator,
} from "./model/retrieval.ts";
export type {
	GradeImageArgs,
	GradeImageResult,
	GradeVideoArgs,
	GradeVideoResult,
	MediaInfoResult,
	MediaJobResult,
	PreviewVideoGradeArgs,
	RunFfmpegArgs,
	RunFfprobeArgs,
} from "./model/media.ts";

export type { EmbeddingProvider, TextEmbedStatus, TextEmbedStatusKind } from "./model/text-embed.ts";
export type { RerankProvider } from "./model/rerank.ts";
export type { DescribeOptions } from "./rag/description.ts";
export type { MediaDescription } from "./model/media-description.ts";
export type { EmbedOptions } from "./rag/service.ts";
export { IMAGE_VLM_SYSTEM_PROMPT, IMAGE_VLM_USER_PROMPT } from "./model/image-vlm.ts";
export type { ImageVlmInput, ImageVlmProvider, ImageVlmStatus, ImageVlmStatusKind } from "./model/image-vlm.ts";
export { VIDEO_VLM_FRAMES_PROMPT, VIDEO_VLM_SYSTEM_PROMPT, VIDEO_VLM_USER_PROMPT } from "./model/video-vlm.ts";
export type {
	VideoVlmDescribeRequest,
	VideoVlmFrame,
	VideoVlmNativeInput,
	VideoVlmProvider,
	VideoVlmStatus,
	VideoVlmStatusKind,
} from "./model/video-vlm.ts";
export { AUDIO_WRITEUP_SYSTEM_PROMPT, AUDIO_WRITEUP_USER_PROMPT } from "./model/audio-writeup.ts";
export type {
	AudioWriteupInput,
	AudioWriteupProvider,
	AudioWriteupStatus,
	AudioWriteupStatusKind,
} from "./model/audio-writeup.ts";

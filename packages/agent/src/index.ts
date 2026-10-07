export type {
	LoomAgentEvent,
	LoomAgentOptions,
	LoomChatEndpoint,
	LoomPromptOptions,
	LoomTranscriptMessage,
	LoomTool,
	LoomToolContentPart,
	LoomToolResult,
} from "./types.ts";
export { toolResultText } from "./types.ts";
export type {
	AssetRefAttachment,
	LoomAssetType,
	LoomUserAttachment,
	UiSelectionAttachment,
	UiSelectionFields,
} from "./attachments.ts";
export {
	contentWithPlacedAssets,
	foldUserMessageForLlm,
	foldUserText,
	formatAssetRefBlock,
	formatUiSelectionBlock,
	implicitSelectionAttachments,
	isAssetRefAttachment,
	isUiSelectionAttachment,
	latestUiSelectionAssetId,
	parseUserAttachments,
	promptAttachments,
	uiSelectionToAttach,
	userTextFromContent,
} from "./attachments.ts";
export {
	assetRefBlocks,
	assetRefMarker,
	composerLayoutText,
	displayAssetRefs,
	inlineAssetIds,
	isRelativeLibraryPath,
	parseComposerAssetInputs,
	replaceAssetRefBlocks,
	splitInlineAssetRefs,
	splitStoredAssetText,
	stripInlineAssetRefs,
} from "./composer-asset.ts";
export {
	bytesToBase64,
	COMPOSER_IMAGE_MAX_BYTES,
	COMPOSER_IMAGE_MAX_COUNT,
	parseComposerImageInputs,
	sniffComposerImage,
	type ComposerImageInput,
	type ComposerImageMime,
} from "./composer-image.ts";
export { chatEndpointReady, buildChatModels, DEFAULT_CHAT_CONTEXT_WINDOW } from "./pi-adapter.ts";
export { DEFAULT_SESSION_TITLE, titleFromUserText } from "./session-title.ts";
export { createWorkspaceTools, toHarnessTool, type WorkspaceTools } from "./pi-tools.ts";
export { HarnessSessionManager, type HarnessSessionRecord, type HarnessSessionSummary, type HarnessContextUsage } from "./harness-session-manager.ts";
export type { LoomTraceSpan } from "./run-trace.ts";
export {
	AGENT_PERMISSION_LEVELS,
	AGENT_PERMISSION_OPTIONS,
	DEFAULT_AGENT_PERMISSION,
	gatedToolNames,
	parseAgentPermissionLevel,
	toolNeedsApproval,
	type AgentPermissionLevel,
	type ToolGateDecision,
} from "./tool-permission.ts";

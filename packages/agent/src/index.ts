export type {
	LoomAgent,
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
	LoomAssetType,
	LoomUserAttachment,
	UiSelectionAttachment,
	UiSelectionFields,
} from "./attachments.ts";
export {
	foldUserMessageForLlm,
	foldUserText,
	formatUiSelectionBlock,
	isUiSelectionAttachment,
	latestUiSelectionAssetId,
	parseUserAttachments,
	uiSelectionToAttach,
	userTextFromContent,
} from "./attachments.ts";
export { chatEndpointReady, createLoomAgent, createWorkspaceTools, type WorkspaceTools } from "./pi-adapter.ts";

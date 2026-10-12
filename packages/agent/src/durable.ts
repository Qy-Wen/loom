// Thin durable facade; application integration migrates separately from the legacy root export.
export * from "./durable-adapter.ts";
export { createModels } from "@earendil-works/pi-ai/models";
export type { Context } from "@earendil-works/chord";
export { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
export { LibraryAgent, type LibraryAgentOptions } from "./library-agent.ts";
export { createWorkspaceTools, toDurableTool, type WorkspaceToolOptions } from "./pi-tools.ts";
export { createLibraryExtension, LoomMemoryDoc, type LibraryExtensionOptions } from "./library-extension.ts";
export { createSpecialistExtension, partitionLibraryTools } from "./specialist.ts";
export { createAutoMemoryTool } from "./library-auto-memory.ts";
export { ToolGate, LoomApprovalsDoc, clearPendingApprovals, toolEventId, type PendingToolApproval } from "./tool-gate.ts";
export type { LoomSessionSummary, LoomSessionRecord, LoomContextUsage } from "./session-dto.ts";
export {
	FORK_TITLE_SUFFIX,
	LoomConversationDoc,
	listLoomConversations,
	setConversationArchived,
	setConversationTitle,
	type LoomConversationMetadata,
	type LoomConversationSummary,
	type LoomConversationListOptions,
} from "./conversation-metadata.ts";

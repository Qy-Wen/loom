// Thin facade: forward native durable primitives and add Loom library assembly/policy.
export * from "./durable-adapter.ts";
export { createModels } from "@earendil-works/pi-ai/models";
export type { Context } from "@earendil-works/chord";
export { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
export { LibraryRuntime, type LibraryRuntimeOptions } from "./library-runtime.ts";
export { createChatCustomProvider } from "./chat-provider.ts";
export { createWorkspaceTools, toDurableTool, type WorkspaceToolOptions } from "./pi-tools.ts";
export { createToolResultStorage } from "./tool-result-storage.ts";
export { createLibraryExtension, LoomMemoryDoc, type LibraryExtensionOptions } from "./library-extension.ts";
export { createChatExtensions } from "./chat-extensions.ts";
export { createSpecialistExtension, partitionLibraryTools } from "./specialist.ts";
export { loadLibrarySkills, formatSkillsForSystemPrompt, LIBRARY_SKILLS_DIR } from "./library-skills.ts";
export type { Skill, SkillDiagnostic } from "./library-skills.ts";
export { createAutoMemoryTool } from "./library-auto-memory.ts";
export { ToolGate, LoomApprovalsDoc, clearPendingApprovals, toolEventId, type PendingToolApproval } from "./tool-gate.ts";
export type { LoomSessionSummary, LoomSessionRecord, LoomContextUsage, LoomSessionModel } from "./session-dto.ts";
export { contextUsage } from "./context-usage.ts";
export { DurableTrace } from "./durable-trace.ts";
export { TraceStore, type LoomTraceRecord, type LoomTraceStatus } from "./trace-store.ts";
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

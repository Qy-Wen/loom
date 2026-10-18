// Thin facade: forward native durable primitives and add Loom library assembly/policy.
export * from "./durable-adapter.ts";
export { createModels } from "@earendil-works/pi-ai/models";
export type { Context } from "@earendil-works/chord";
export { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
export { LibraryRuntime, type LibraryRuntimeOptions } from "./runtime/library-runtime.ts";
export { createChatCustomProvider } from "./models/chat-provider.ts";
export { createWorkspaceTools, toDurableTool, type WorkspaceToolOptions } from "./tools/pi-tools.ts";
export { createToolResultStorage } from "./tools/tool-result-storage.ts";
export { createLibraryExtension, LoomMemoryDoc, type LibraryExtensionOptions } from "./extensions/library-extension.ts";
export { createChatExtensions } from "./extensions/chat-extensions.ts";
export { createSpecialistExtension, partitionLibraryTools } from "./extensions/specialist.ts";
export { loadLibrarySkills, formatSkillsForSystemPrompt, LIBRARY_SKILLS_DIR } from "./extensions/library-skills.ts";
export type { Skill, SkillDiagnostic } from "./extensions/library-skills.ts";
export { createAutoMemoryTool } from "./extensions/library-auto-memory.ts";
export { ToolGate, LoomApprovalsDoc, clearPendingApprovals, toolEventId, type PendingToolApproval } from "./tools/tool-gate.ts";
export type { LoomSessionSummary, LoomSessionRecord, LoomContextUsage, LoomSessionModel } from "./runtime/session-dto.ts";
export { contextUsage } from "./runtime/context-usage.ts";
export { DurableTrace } from "./trace/durable-trace.ts";
export { TraceStore, type LoomTraceRecord, type LoomTraceStatus } from "./trace/trace-store.ts";
export {
	FORK_TITLE_SUFFIX,
	LoomConversationDoc,
	listLoomConversations,
	setConversationArchived,
	setConversationTitle,
	type LoomConversationMetadata,
	type LoomConversationSummary,
	type LoomConversationListOptions,
} from "./runtime/conversation-metadata.ts";

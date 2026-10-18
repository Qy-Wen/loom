import { EventType, type Message } from "@ag-ui/core";
import { toolEventId, type AgentEvent, type ConversationId, type PendingToolApproval } from "@loom/agent";
import { toolResultContent, transcriptText } from "../../shared/ag-ui-messages.ts";
import { chatContent } from "./chat-record.ts";

let next = 0;
export const temporaryMessageId = () => `loom-live-${Date.now()}-${next++}`;

/** Durable-to-AG-UI presentation state. It never submits work or owns subscriptions. */
export function createAgUiEvents(emit: (event: object) => void, options: {
	threadId: string;
	submit: boolean;
	replay: boolean;
	optimisticUser?: Message;
	watchChild: (id: number) => Promise<void>;
}) {
	const { threadId, submit, replay, optimisticUser, watchChild } = options;
	const conversationId = Number(threadId) as ConversationId;
	let messageId = temporaryMessageId();
	let textOpen = false;
	let reasoningOpen = false;
	let sentText = "";
	let sentThinking = "";
	const partialBlocks = new Map<number, { type: string; text?: string; thinking?: string; redacted?: boolean }>();
	const close = () => {
		if (reasoningOpen) { emit({ type: EventType.REASONING_MESSAGE_END, messageId: `${messageId}-thinking` }); emit({ type: EventType.REASONING_END, messageId: `${messageId}-thinking` }); reasoningOpen = false; }
		if (textOpen) { emit({ type: EventType.TEXT_MESSAGE_END, messageId }); textOpen = false; }
	};
	const textDelta = (delta: string) => {
		if (!delta) return;
		if (!textOpen) { textOpen = true; emit({ type: EventType.TEXT_MESSAGE_START, role: "assistant", messageId }); }
		emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta }); sentText += delta;
	};
	const thinkingDelta = (delta: string) => {
		if (!delta) return;
		if (!reasoningOpen) { reasoningOpen = true; emit({ type: EventType.REASONING_START, messageId: `${messageId}-thinking` }); emit({ type: EventType.REASONING_MESSAGE_START, role: "reasoning", messageId: `${messageId}-thinking` }); }
		emit({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: `${messageId}-thinking`, delta }); sentThinking += delta;
	};
	const renderPartial = () => {
		const blocks = [...partialBlocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
		const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
		const thinking = blocks.filter((block) => block.type === "thinking" && !block.redacted).map((block) => block.thinking ?? "").join("");
		if (thinking.startsWith(sentThinking)) thinkingDelta(thinking.slice(sentThinking.length));
		if (text.startsWith(sentText)) textDelta(text.slice(sentText.length));
	};
	const knownTools = new Set<string>();
	const progress = new Map<string, string>();
	let submittedEntry: string | undefined;
	const startTool = (id: string, name: string, args: unknown, parentMessageId = messageId) => {
		if (knownTools.has(id)) return;
		close(); knownTools.add(id);
		emit({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name, parentMessageId });
		emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify(args) });
	};
	const onEvent = async (event: AgentEvent) => {
		switch (event.type) {
			case "snapshot": {
				// History is loaded once over IPC. This stream owns only optimistic input and active work.
				close();
				messageId = temporaryMessageId(); sentText = ""; sentThinking = ""; partialBlocks.clear(); knownTools.clear();
				emit({ type: EventType.MESSAGES_SNAPSHOT, messages: submit && !replay && !submittedEntry && optimisticUser ? [optimisticUser] : [] });
				if (event.generation?.message) {
					partialBlocks.clear();
					event.generation.message.content.forEach((block, index) => partialBlocks.set(index, { ...block }));
					renderPartial();
				}
				for (const slot of event.tools) {
					const args = event.entries.flatMap((entry) => entry.model ?? []).flatMap((message) => message.role === "assistant" ? message.content : []).find((part) => part.type === "toolCall" && part.id === slot.callId);
					const parent = event.entries.find((entry) => entry.model?.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === slot.callId)));
					if (slot.status !== "done") startTool(toolEventId(conversationId, slot.callId), slot.name, args?.type === "toolCall" ? args.arguments : {}, parent ? String(parent.id) : undefined);
					const childId = (slot.details as { conversationId?: number } | undefined)?.conversationId;
					if (childId) await watchChild(childId);
				}
				break;
			}
			case "turn_start": close(); messageId = temporaryMessageId(); sentText = ""; sentThinking = ""; partialBlocks.clear(); break;
			case "message_start":
				if (event.message.role === "assistant") {
					partialBlocks.clear();
					event.message.content.forEach((block, index) => partialBlocks.set(index, { ...block }));
					renderPartial();
				}
				break;
			case "message_update":
				for (const change of event.changes) {
					if (change.type === "message") {
						partialBlocks.clear();
						change.message.content.forEach((block, index) => partialBlocks.set(index, { ...block }));
					} else if ("block" in change) partialBlocks.set(change.contentIndex, { ...change.block });
					else if (change.type === "text_delta" || change.type === "thinking_delta") {
						const field = change.type === "text_delta" ? "text" : "thinking";
						const block = partialBlocks.get(change.contentIndex) ?? { type: field };
						block[field] = (block[field] ?? "") + change.delta;
						partialBlocks.set(change.contentIndex, block);
					}
				}
				renderPartial(); break;
			case "message_end": {
				const message = event.entry.model?.[0];
				if (message?.role === "user") {
					const id = String(event.entry.id);
					if (submit && !submittedEntry) { submittedEntry = id; emit({ type: EventType.CUSTOM, name: "loom.user_entry", value: { fromId: optimisticUser?.id, entryId: id } }); }
					else { emit({ type: EventType.TEXT_MESSAGE_START, role: "user", messageId: id, metadata: { "loom.clientMessageId": (event.entry.data as { clientMessageId?: string })?.clientMessageId ?? "" } }); emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: (event.entry.data as { text?: string })?.text ?? transcriptText(message.content) }); emit({ type: EventType.TEXT_MESSAGE_END, messageId: id }); }
					break;
				}
				if (message?.role !== "assistant") break;
				const text = transcriptText(message.content);
				const thinking = message.content.filter((part) => part.type === "thinking" && !part.redacted).map((part) => part.type === "thinking" ? part.thinking : "").join("");
				if (thinking.startsWith(sentThinking)) thinkingDelta(thinking.slice(sentThinking.length));
				if (text.startsWith(sentText)) textDelta(text.slice(sentText.length));
				close();
				emit({ type: EventType.CUSTOM, name: "loom.adopt_entry", value: { fromId: messageId, entryId: String(event.entry.id) } });
				messageId = String(event.entry.id);
				break;
			}
			case "tool_execution_start": startTool(toolEventId(conversationId, event.toolCallId), event.toolName, event.args); break;
			case "tool_execution_update": {
				const childId = (event.details as { conversationId?: number } | undefined)?.conversationId;
				if (childId) await watchChild(childId);
				const id = toolEventId(conversationId, event.toolCallId);
				const prior = progress.get(id) ?? "";
				const value = event.output && "set" in event.output ? event.output.set : prior.slice(event.output?.trimStart ?? 0) + (event.output?.append ?? "");
				progress.set(id, value);
				emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: `loom-tool-${id}`, activityType: "loom.tool_progress", content: { name: event.toolName, text: value, hidden: false } }); break;
			}
			case "tool_execution_end": {
				const id = toolEventId(conversationId, event.toolCallId); const result = event.entry?.model?.[0];
				emit({ type: EventType.TOOL_CALL_END, toolCallId: id });
				emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: `loom-tool-${id}`, activityType: "loom.tool_progress", content: { name: event.toolName, text: "", hidden: true } });
				emit({ type: EventType.TOOL_CALL_RESULT, messageId: String(event.entry?.id ?? id), toolCallId: id, role: "tool", content: result && "content" in result ? toolResultContent(chatContent(result.content, threadId, String(event.entry?.id))) : JSON.stringify(event.result?.structuredOutput ?? "") });
				if (result?.role === "toolResult" && result.details !== undefined) emit({ type: EventType.CUSTOM, name: "loom.tool_result", value: { toolCallId: id, toolName: event.toolName, isError: result.isError, details: result.details } });
				break;
			}
			case "auto_retry_start": emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: "loom-retry", activityType: "loom.retry", content: { phase: "wait", attempt: event.attempt, delayMs: Math.max(0, event.at - Date.now()), errorMessage: event.errorMessage } }); break;
			case "auto_retry_end": emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: "loom-retry", activityType: "loom.retry", content: { phase: "done", attempt: event.attempt } }); break;
			case "compaction_start": case "compaction_end": emit({ type: EventType.CUSTOM, name: "loom.compaction", value: { phase: event.type === "compaction_start" ? "start" : "end", reason: event.reason, ...(event.type === "compaction_end" ? { status: event.error ? "failed" : "completed" } : {}) } }); break;
		}
	};
	const approvalPresenter = () => {
		let pending = new Set<string>();
		return (value: { pending: PendingToolApproval[] } | null) => {
			const current = new Set(value?.pending.map((row) => row.toolCallId));
			for (const row of value?.pending ?? []) { startTool(row.toolCallId, row.toolName, row.args); emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: `loom-gate-${row.toolCallId}`, activityType: "loom.tool_gate", content: { toolCallId: row.toolCallId, pending: true } }); }
			for (const id of pending) if (!current.has(id)) emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: `loom-gate-${id}`, activityType: "loom.tool_gate", content: { toolCallId: id, pending: false } });
			pending = current;
		};
	};

	const onChildEvent = async (id: number, event: AgentEvent) => {
		if (event.type === "snapshot") {
			for (const slot of event.tools) {
				const args = event.entries.flatMap((entry) => entry.model ?? []).flatMap((message) => message.role === "assistant" ? message.content : []).find((part) => part.type === "toolCall" && part.id === slot.callId);
				const parent = event.entries.find((entry) => entry.model?.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === slot.callId)));
				if (slot.status !== "done") startTool(toolEventId(id as ConversationId, slot.callId), slot.name, args?.type === "toolCall" ? args.arguments : {}, parent ? String(parent.id) : undefined);
			}
		}
		if (event.type === "tool_execution_start") startTool(toolEventId(id as ConversationId, event.toolCallId), event.toolName, event.args);
		if (event.type === "tool_execution_end") {
			const toolId = toolEventId(id as ConversationId, event.toolCallId); const result = event.entry?.model?.[0];
			emit({ type: EventType.TOOL_CALL_END, toolCallId: toolId });
			emit({ type: EventType.TOOL_CALL_RESULT, messageId: String(event.entry?.id ?? toolId), toolCallId: toolId, role: "tool", content: result && "content" in result ? toolResultContent(chatContent(result.content, String(id), String(event.entry?.id))) : "" });
			if (result?.role === "toolResult" && result.details !== undefined) emit({ type: EventType.CUSTOM, name: "loom.tool_result", value: { toolCallId: toolId, toolName: event.toolName, isError: result.isError, details: result.details } });
		}
	};
	return { onEvent, onChildEvent, approvals: approvalPresenter, close };
}

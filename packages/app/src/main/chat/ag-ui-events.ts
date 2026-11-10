import { EventType, type Message } from "@ag-ui/core";
import { toolEventId, type ConversationId, type EntryRecord, type LiveState, type PendingToolApproval, type TranscriptView } from "@loom/agent";
import { toolResultContent, transcriptText } from "../../shared/ag-ui-messages.ts";
import { chatContent } from "./chat-record.ts";

let next = 0;
export const temporaryMessageId = () => `loom-live-${Date.now()}-${next++}`;

/** Present native conversation state as AG-UI increments. Subscriptions and history paging belong to the adapter. */
export function createAgUiEvents(emit: (event: object) => void, options: {
	threadId: string;
	submit: boolean;
	replay: boolean;
	optimisticUser?: Message;
	watchChild: (id: number) => Promise<void>;
}) {
	const { threadId, submit, replay, optimisticUser, watchChild } = options;
	let messageId = temporaryMessageId();
	let textOpen = false;
	let reasoningOpen = false;
	let sentText = "";
	let sentThinking = "";
	let submittedEntry: string | undefined;
	const knownTools = new Set<string>();
	const endedTools = new Set<string>();
	const progress = new Map<string, string>();
	const lastEntries = new Map<number, number>();
	const previousLive = new Map<number, LiveState>();
	const close = () => {
		if (reasoningOpen) { emit({ type: EventType.REASONING_MESSAGE_END, messageId: `${messageId}-thinking` }); emit({ type: EventType.REASONING_END, messageId: `${messageId}-thinking` }); reasoningOpen = false; }
		if (textOpen) { emit({ type: EventType.TEXT_MESSAGE_END, messageId }); textOpen = false; }
	};
	const resetMessage = () => { close(); messageId = temporaryMessageId(); sentText = ""; sentThinking = ""; };
	const renderMessage = (content: readonly { type: string; text?: string; thinking?: string; redacted?: boolean }[]) => {
		const text = content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
		const thinking = content.filter((part) => part.type === "thinking" && !part.redacted).map((part) => part.thinking ?? "").join("");
		if (thinking.startsWith(sentThinking) && thinking.length > sentThinking.length) {
			if (!reasoningOpen) { reasoningOpen = true; emit({ type: EventType.REASONING_START, messageId: `${messageId}-thinking` }); emit({ type: EventType.REASONING_MESSAGE_START, role: "reasoning", messageId: `${messageId}-thinking` }); }
			emit({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: `${messageId}-thinking`, delta: thinking.slice(sentThinking.length) }); sentThinking = thinking;
		}
		if (text.startsWith(sentText) && text.length > sentText.length) {
			if (!textOpen) { textOpen = true; emit({ type: EventType.TEXT_MESSAGE_START, role: "assistant", messageId }); }
			emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text.slice(sentText.length) }); sentText = text;
		}
	};
	const startTool = (id: string, name: string, args: unknown, parentMessageId = messageId) => {
		if (knownTools.has(id)) return;
		knownTools.add(id);
		emit({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name, parentMessageId });
		emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify(args) });
	};
	const endTool = (id: string, name: string, entry?: EntryRecord, error = "") => {
		if (endedTools.has(id)) return;
		endedTools.add(id); progress.delete(id);
		const result = entry?.model?.[0];
		emit({ type: EventType.TOOL_CALL_END, toolCallId: id });
		emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: `loom-tool-${id}`, activityType: "loom.tool_progress", content: { name, text: "", hidden: true } });
		emit({ type: EventType.TOOL_CALL_RESULT, messageId: String(entry?.id ?? id), toolCallId: id, role: "tool", content: result?.role === "toolResult" ? toolResultContent(chatContent(result.content, id.split("/")[0]!, String(entry!.id))) : error });
		if (result?.role === "toolResult" && result.details !== undefined) emit({ type: EventType.CUSTOM, name: "loom.tool_result", value: { toolCallId: id, toolName: name, isError: result.isError, details: result.details } });
	};
	const present = async (id: number, view: TranscriptView, child: boolean) => {
		const live = (view.docs["pi.live"] ?? {}) as LiveState;
		const before = previousLive.get(id);
		const entries = view.items.flatMap((item) => item.kind === "entry" ? [item.entry] : []);
		const initial = !lastEntries.has(id);
		if (initial && !child) {
			emit({ type: EventType.MESSAGES_SNAPSHOT, messages: submit && !replay && !submittedEntry && optimisticUser ? [optimisticUser] : [] });
			lastEntries.set(id, entries.at(-1)?.id ?? 0);
		}
		const fresh = entries.filter((entry) => entry.id > (lastEntries.get(id) ?? 0));
		for (const entry of fresh) {
			const message = entry.model?.[0];
			if (!child && message?.role === "user") {
				const entryId = String(entry.id);
				if (submit && !submittedEntry) { submittedEntry = entryId; emit({ type: EventType.CUSTOM, name: "loom.user_entry", value: { fromId: optimisticUser?.id, entryId } }); }
				else {
					emit({ type: EventType.TEXT_MESSAGE_START, role: "user", messageId: entryId, metadata: { "loom.clientMessageId": (entry.data as { clientMessageId?: string })?.clientMessageId ?? "" } });
					emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: entryId, delta: (entry.data as { text?: string })?.text ?? transcriptText(message.content) });
					emit({ type: EventType.TEXT_MESSAGE_END, messageId: entryId });
				}
			}
			if (message?.role === "assistant") {
				if (!child) {
					renderMessage(message.content); close();
					emit({ type: EventType.CUSTOM, name: "loom.adopt_entry", value: { fromId: messageId, entryId: String(entry.id) } });
					resetMessage();
				}
				for (const part of message.content) if (part.type === "toolCall") startTool(toolEventId(id as ConversationId, part.id), part.name, part.arguments, String(entry.id));
			}
			if (message?.role === "toolResult") {
				const toolId = toolEventId(id as ConversationId, message.toolCallId);
				startTool(toolId, message.toolName, {});
				endTool(toolId, message.toolName, entry);
			}
			if (!child && entry.kind === "pi.compaction") emit({ type: EventType.CUSTOM, name: "loom.compaction", value: { phase: "end", reason: (entry.data as { reason?: string })?.reason, status: "completed" } });
		}
		lastEntries.set(id, entries.at(-1)?.id ?? lastEntries.get(id) ?? 0);
		if (!child && live.generation?.message) {
			if (before?.generation?.retry && !live.generation.retry) resetMessage();
			renderMessage(live.generation.message.content);
		}
		for (const slot of [...live.tools ?? [], ...live.nestedTools ?? []]) {
			const toolId = toolEventId(id as ConversationId, slot.callId);
			const parent = entries.findLast((entry) => entry.model?.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === slot.callId)));
			const call = parent?.model?.flatMap((message) => message.role === "assistant" ? message.content : []).find((part) => part.type === "toolCall" && part.id === slot.callId);
			if (slot.status !== "done" || !initial || child) startTool(toolId, slot.name, "arguments" in slot ? slot.arguments : call?.type === "toolCall" ? call.arguments : {}, parent ? String(parent.id) : undefined);
			const childId = (slot.details as { conversationId?: number } | undefined)?.conversationId;
			if (childId) await watchChild(childId);
			if (slot.status === "done") {
				if (knownTools.has(toolId)) endTool(toolId, slot.name, "entry" in slot ? entries.find((entry) => entry.id === slot.entry) : undefined, slot.diagnostics?.map((item) => item.message).join("\n"));
			} else if (slot.output !== undefined && progress.get(toolId) !== slot.output) {
				progress.set(toolId, slot.output);
				emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: `loom-tool-${toolId}`, activityType: "loom.tool_progress", content: { name: slot.name, text: slot.output, hidden: false } });
			}
		}
		for (const slot of [...before?.tools ?? [], ...before?.nestedTools ?? []]) {
			if (![...live.tools ?? [], ...live.nestedTools ?? []].some((current) => current.callId === slot.callId)) {
				const toolId = toolEventId(id as ConversationId, slot.callId);
				if (knownTools.has(toolId)) endTool(toolId, slot.name);
			}
		}
		if (!child) {
			const retry = live.generation?.retry;
			if (retry && retry !== before?.generation?.retry) emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: "loom-retry", activityType: "loom.retry", content: { phase: "wait", attempt: live.generation!.attempt, delayMs: Math.max(0, retry.at - Date.now()), errorMessage: retry.error } });
			else if (!retry && before?.generation?.retry) emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: "loom-retry", activityType: "loom.retry", content: { phase: "done", attempt: before.generation.attempt } });
			for (const compaction of live.compactions ?? []) if (!before?.compactions?.some((prior) => prior.taskId === compaction.taskId)) emit({ type: EventType.CUSTOM, name: "loom.compaction", value: { phase: "start", reason: compaction.trigger } });
			const failure = live.compactionFailure;
			if (failure && failure !== before?.compactionFailure) emit({ type: EventType.CUSTOM, name: "loom.compaction", value: { phase: "end", reason: failure.trigger, status: "failed" } });
		}
		previousLive.set(id, live);
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
	return { onView: (view: TranscriptView) => present(Number(threadId), view, false), onChildView: (id: number, view: TranscriptView) => present(id, view, true), approvals: approvalPresenter, close };
}

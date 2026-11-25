import type { Message } from "@ag-ui/core";
import { ChatError } from "@loom/ag-ui-react";
import { ChatView } from "@loom/ag-ui-react/chat-view";
import "@loom/ag-ui-react/markdown.css";
import type { LoomTranscriptMessage, LoomUserAttachment } from "@loom/agent";
import { contentWithPlacedAssets } from "@loom/agent/attachments";
import { displayAssetRefs, storedAssetRefs } from "@loom/agent/composer-asset";
import { isChatErrorMessageId } from "../../shared/chat-error.ts";
import { useLocale } from "../locale.tsx";
import { useAssistantAssetMarkdown } from "./assistant-asset-text.tsx";
import { editableText, placedChips } from "./chat-content.ts";
import { useChatSession } from "./chat-context.ts";
import { ChatEmptyState } from "./chat-empty.tsx";
import { turnEndReplyIds } from "./chat-turns.ts";
import { useCommandAllows } from "./command-allows.ts";
import { HistoryMessageEditor } from "./history-message-editor.tsx";
import { InlineMessageBody } from "./inline-asset-text.tsx";
import { RunActivity } from "./run-activity.tsx";
import { ToolCallCard } from "./tool-call-views.tsx";

function messageAssets(entryId: string | undefined, transcript: readonly LoomTranscriptMessage[]): LoomUserAttachment[] {
	if (!entryId) return [];
	const message = transcript.find((row) => row.id === entryId);
	return storedAssetRefs(message && "attachments" in message ? message.attachments : undefined);
}

export function SessionTranscript({ messages, isRunning, libraryRoot }: { messages: readonly Message[]; isRunning: boolean; libraryRoot: string }) {
	const { threadId, stored, transcript, model, branch } = useChatSession();
	const { allows } = useCommandAllows();
	const { t } = useLocale();
	const markdown = useAssistantAssetMarkdown();
	const turnEnds = turnEndReplyIds(stored);
	const toolStarts = new Map<string, number>();
	if (isRunning) for (const message of messages) {
		if (message.role !== "activity" || message.activityType !== "loom.tool_progress" || message.content.hidden === true) continue;
		const { toolCallId, startedAt } = message.content;
		if (typeof toolCallId === "string" && typeof startedAt === "number" && Number.isFinite(startedAt)) toolStarts.set(toolCallId, startedAt);
	}

	return <ChatView
		messages={messages}
		isRunning={isRunning}
		threadId={threadId}
		className="loom-chat-view thin-scroll"
		emptyState={<ChatEmptyState />}
		labels={{ conversation: t.chat.conversation, working: t.chat.working, latest: t.chat.latest, reasoning: t.chat.reasoning, copy: t.common.copy }}
		slots={{
			markdown,
			userMessage(message, text) {
				const entryId = stored.some((row) => row.role === "user" && row.id === message.id) ? message.id : undefined;
				const assets = displayAssetRefs(text, messageAssets(entryId, transcript));
				if (entryId && branch.editingId === entryId) return {
					replacement: <HistoryMessageEditor
						key={entryId}
						model={model}
						text={text}
						assets={assets}
						busy={branch.busy}
						error={branch.error}
						onCancel={branch.cancelEdit}
						onSend={(next, selectedModel) => {
							const body = contentWithPlacedAssets(next, placedChips(displayAssetRefs(next, assets)));
							void branch.commitEdit(body, selectedModel);
						}}
					/>,
				};
				return {
					content: assets.length ? <InlineMessageBody text={text} assets={assets} /> : undefined,
					actions: entryId && editableText(text) && !branch.busy && <button type="button" aria-label={t.common.edit} data-tooltip={t.common.edit} onClick={() => branch.edit(entryId)}>
						<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m14 5 5 5M4 20l4.5-1 11-11a2 2 0 0 0-5-5l-11 11L4 20Z" /></svg>
					</button>,
				};
			},
			assistantMessage(message, text) {
				if (isChatErrorMessageId(message.id)) return {
					replacement: <ChatError label={t.chat.requestFailed} message={text} />,
				};
				if (!turnEnds.has(message.id) || branch.busy) return;
				return {
					actions: <button type="button" aria-label={t.chat.fork} data-tooltip={t.chat.fork} onClick={() => branch.fork(message.id)}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
							<circle cx="12" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" />
							<path d="M18 9v2a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V9" /><path d="M12 14v1" />
						</svg>
					</button>,
				};
			},
			tool: ({ call, result }) => <ToolCallCard name={call.function.name} parameters={call.function.arguments} result={result}
				toolCallId={call.id} startedAt={toolStarts.get(call.id)} libraryRoot={libraryRoot} allows={allows} />,
			activity: (message) => <RunActivity message={message} />,
		}}
	/>;
}

import type { AssistantMessage, Message, UserMessage } from "@ag-ui/core";
import { MessageList } from "@loom/ag-ui-react";
import { useState } from "react";
import { RunActivity } from "./run-activity.tsx";
import { ToolCallCard } from "./tool-call-views.tsx";
import { useCommandAllows } from "./command-allows.ts";
import type { LoomTranscriptMessage, LoomUserAttachment } from "@loom/agent";
import { contentWithPlacedAssets } from "@loom/agent/attachments";
import { displayAssetRefs, inlineReferenceKeys, storedAssetRefs } from "@loom/agent/composer-asset";
import { isChatErrorMessageId } from "../../shared/chat-error.ts";
import { useLocale } from "../locale.tsx";
import { AssistantMarkdown } from "./assistant-asset-text.tsx";
import { InlineMessageBody } from "./inline-asset-text.tsx";
import { HistoryMessageEditor } from "./history-message-editor.tsx";
import { useChatSession } from "./chat-context.ts";
import { editableText, messageText, placedChips } from "./chat-content.ts";
import { turnEndReplyIds } from "./chat-turns.ts";

function ForkIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<circle cx="12" cy="18" r="3" />
			<circle cx="6" cy="6" r="3" />
			<circle cx="18" cy="6" r="3" />
			<path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
			<path d="M12 12v3" />
		</svg>
	);
}

function CopyMessage({ text, user = false }: { text: string; user?: boolean }) {
	const { t } = useLocale();
	return <button type="button" aria-label={t.common.copy} data-tooltip={t.common.copy} data-testid={user ? "chat-user-copy-button" : "chat-copy-button"} onClick={() => { void navigator.clipboard.writeText(text).catch(() => {}); }}>
		<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
		</svg>
	</button>;
}

function SessionAssistantMessage({ message, canFork }: { message: AssistantMessage; canFork: boolean }) {
	const { t } = useLocale();
	const { branch } = useChatSession();
	const text = messageText(message);
	if (isChatErrorMessageId(message.id)) {
		return <div className="chat-error" role="alert">
			<div className="chat-error-label">{t.chat.requestFailed}</div>
			<p className="chat-error-body">{text}</p>
		</div>;
	}
	if (!text.trim()) return null;
	return <article className="session-assistant-message" data-testid="chat-assistant-message">
		<AssistantMarkdown content={text} />
		<div className="session-message-toolbar" data-testid="chat-assistant-toolbar">
			<CopyMessage text={text} />
			{canFork && !branch.busy && <button type="button" aria-label={t.chat.fork} data-tooltip={t.chat.fork} onClick={() => branch.fork(message.id)}><ForkIcon /></button>}
		</div>
	</article>;
}

function ReasoningMessage({ text }: { text: string }) {
	const { t } = useLocale();
	const [open, setOpen] = useState(false);
	return <div className="session-reasoning">
		<button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{t.chat.reasoning}<span aria-hidden="true">›</span></button>
		{open && <AssistantMarkdown content={text} />}
	</div>;
}

function messageAssets(entryId: string | undefined, transcript: readonly LoomTranscriptMessage[]): LoomUserAttachment[] {
	if (!entryId) return [];
	const message = transcript.find((row) => row.id === entryId);
	return storedAssetRefs(message && "attachments" in message ? message.attachments : undefined);
}

function SessionUserMessage({ message }: { message: UserMessage }) {
	const { t } = useLocale();
	const { branch, stored, transcript, model } = useChatSession();
	const text = messageText(message);
	const entryId = stored.some((row) => row.role === "user" && row.id === message.id) ? message.id : undefined;
	const assets = displayAssetRefs(text, messageAssets(entryId, transcript));
	const canEdit = Boolean(entryId && editableText(text) && !branch.busy);
	if (entryId && branch.editingId === entryId) {
		return (
			<HistoryMessageEditor
				key={entryId}
				model={model}
				text={text}
				assets={assets}
				busy={branch.busy}
				error={branch.error}
				onCancel={() => branch.cancelEdit()}
				onSend={(next, selectedModel) => {
					const body = contentWithPlacedAssets(next, placedChips(displayAssetRefs(next, assets)));
					void branch.commitEdit(body, selectedModel);
				}}
			/>
		);
	}
	return <article className="session-user-message" data-testid="chat-user-message">
		<div className="session-user-bubble"><InlineMessageBody text={text} assets={assets} /></div>
		<div className="session-message-toolbar" data-testid="chat-user-toolbar">
			<CopyMessage text={text} user />
			{canEdit && <button type="button" aria-label={t.common.edit} data-tooltip={t.common.edit} onClick={() => branch.edit(entryId!)}>
				<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m14 5 5 5M4 20l4.5-1 11-11a2 2 0 0 0-5-5l-11 11L4 20Z" /></svg>
			</button>}
		</div>
	</article>;
}

export function SessionMessageView({ messages, isRunning, libraryRoot }: { messages: readonly Message[]; isRunning: boolean; libraryRoot: string }) {
	const { stored } = useChatSession();
	const { allows } = useCommandAllows();
	const { t } = useLocale();
	const turnEnds = turnEndReplyIds(stored);
	const last = messages.findLast((item) => item.role === "assistant" || item.role === "tool" || item.role === "user" || item.role === "reasoning");
	const waiting = isRunning && (last?.role !== "assistant" || !last.content);
	return <div className="session-message-list" data-testid="chat-message-list">
		<MessageList messages={messages} label={t.chat.conversation} renderItem={(item) => {
			if (item.kind === "tool") return <ToolCallCard name={item.call.function.name} parameters={item.call.function.arguments} result={item.result?.content} toolCallId={item.call.id} done={Boolean(item.result)} libraryRoot={libraryRoot} allows={allows} />;
			const { message } = item;
			switch (message.role) {
				case "user": return <SessionUserMessage message={message} />;
				case "assistant": return message.content ? <SessionAssistantMessage message={message} canFork={turnEnds.has(message.id)} /> : null;
				case "reasoning": return message.content ? <ReasoningMessage text={messageText(message)} /> : null;
				case "activity": return <RunActivity message={message} />;
				default: return null;
			}
		}} />
		{waiting && <div className="session-working" data-testid="chat-working" role="status" aria-label={t.chat.working}><span aria-hidden="true" /></div>}
	</div>;
}

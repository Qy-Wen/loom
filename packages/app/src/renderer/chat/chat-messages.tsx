import { CopilotChatAssistantMessage, CopilotChatMessageView, CopilotChatUserMessage, type CopilotChatAssistantMessageProps, type CopilotChatMessageViewProps, type CopilotChatUserMessageProps } from "@copilotkit/react-core/v2";
import type { LoomTranscriptMessage, LoomUserAttachment } from "@loom/agent";
import { contentWithPlacedAssets } from "@loom/agent/attachments";
import { displayAssetRefs, inlineAssetIds, storedAssetRefs } from "@loom/agent/composer-asset";
import { isChatErrorMessageId } from "../../shared/chat-error.ts";
import { useLocale } from "../locale.tsx";
import { AssistantMarkdown } from "./assistant-asset-text.tsx";
import { InlineMessageBody } from "./inline-asset-text.tsx";
import { HistoryMessageEditor } from "./history-message-editor.tsx";
import { useContext } from "react";
import { ChatViewContext, useChatSession } from "./chat-context.ts";
import { editableText, messageText, placedChips } from "./chat-content.ts";

const SessionAssistantMessage = ((props: CopilotChatAssistantMessageProps) => {
	const { t } = useLocale();
	if (isChatErrorMessageId(props.message.id)) {
		const text = typeof props.message.content === "string" ? props.message.content : "";
		return (
			<div className="chat-error" role="alert">
				<div className="chat-error-label">{t.chat.requestFailed}</div>
				<p className="chat-error-body">{text}</p>
			</div>
		);
	}
	return <CopilotChatAssistantMessage {...props} markdownRenderer={AssistantMarkdown} />;
}) as typeof CopilotChatAssistantMessage;

function messageAssets(entryId: string | undefined, transcript: readonly LoomTranscriptMessage[]): LoomUserAttachment[] {
	if (!entryId) return [];
	const message = transcript.find((row) => row.id === entryId);
	return storedAssetRefs(message && "attachments" in message ? message.attachments : undefined);
}

const SessionUserMessage = ((props: CopilotChatUserMessageProps) => {
	const { t } = useLocale();
	const { branch, stored, transcript, model } = useChatSession();
	const text = messageText(props.message);
	const entryId = stored.some((message) => message.role === "user" && message.id === props.message.id) ? props.message.id : undefined;
	const assets = displayAssetRefs(text, messageAssets(entryId, transcript));
	const inline = assets.length > 0 || inlineAssetIds(text).length > 0;
	const canEdit = Boolean(branch && entryId && editableText(text) && !branch.busy);
	if (branch && entryId && branch.editingId === entryId) {
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
	return (
		<CopilotChatUserMessage
			{...props}
			messageRenderer={inline ? ({ content, className }) => (
				<div className={`session-user-bubble${className ? ` ${className}` : ""}`}>
					<InlineMessageBody text={typeof content === "string" ? content : text} assets={assets} />
				</div>
			) : undefined}
			onEditMessage={canEdit ? () => branch!.edit(entryId!) : undefined}
			additionalToolbarItems={canEdit ? (
				<CopilotChatUserMessage.ToolbarButton title={t.chat.fork} onClick={() => branch!.fork(entryId!, text)}>
					<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="12" cy="18" r="3" />
						<circle cx="6" cy="6" r="3" />
						<circle cx="18" cy="6" r="3" />
						<path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
						<path d="M12 12v3" />
					</svg>
				</CopilotChatUserMessage.ToolbarButton>
			) : undefined}
		/>
	);
}) as typeof CopilotChatUserMessage;

export const SessionMessageView = ((props: CopilotChatMessageViewProps) => {
	// CopilotKit reports isRunning while it reconnects to a thread, which would flash the pulsing
	// "running" dot every time a session is created, closed, or switched. Nothing is running yet.
	const { connecting, threadReady } = useContext(ChatViewContext);
	const isRunning = props.isRunning && !connecting && threadReady;
	return <CopilotChatMessageView {...props} isRunning={isRunning} assistantMessage={SessionAssistantMessage} userMessage={SessionUserMessage} />;
}) as typeof CopilotChatMessageView;

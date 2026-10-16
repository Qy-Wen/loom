import { useLayoutEffect, useRef, useState } from "react";
import { CopilotChatAssistantMessage, CopilotChatMessageView, CopilotChatUserMessage, type CopilotChatAssistantMessageProps, type CopilotChatMessageViewProps, type CopilotChatUserMessageProps } from "@copilotkit/react-core/v2";
import type { LoomTranscriptMessage, LoomUserAttachment } from "@loom/agent";
import { contentWithPlacedAssets } from "@loom/agent/attachments";
import { displayAssetRefs, inlineAssetIds, splitStoredAssetText, storedAssetRefs } from "@loom/agent/composer-asset";
import { isChatErrorMessageId } from "../../shared/chat-error.ts";
import { useLocale } from "../locale.tsx";
import { useOpenAsset } from "./asset-open.tsx";
import { AssistantMarkdown } from "./assistant-asset-text.tsx";
import { InlineMessageBody, paintInlineEditor, readInlineEditor, type ChipLabels } from "./inline-asset-text.tsx";
import { useChatSession } from "./chat-context.ts";
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

function InlineEdit({
	text,
	assets,
	busy,
	error,
	onCancel,
	onSend,
}: {
	text: string;
	assets: readonly LoomUserAttachment[];
	busy: boolean;
	error: string | null;
	onCancel: () => void;
	onSend: (text: string) => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const chipLabels: ChipLabels = { remove: t.common.remove, removeNamed: t.chat.removeNamed };
	const openAsset = useOpenAsset();
	const ref = useRef<HTMLTextAreaElement>(null);
	const editorRef = useRef<HTMLDivElement>(null);
	const chips = splitStoredAssetText(text).some((part) => part.type === "asset");
	const [draft, setDraft] = useState(text);
	const fit = (el: HTMLTextAreaElement) => {
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	};
	useLayoutEffect(() => {
		if (chips) {
			const editor = editorRef.current;
			if (!editor) return;
			paintInlineEditor(editor, text, assets, openAsset, chipLabels);
			editor.focus();
			return;
		}
		const el = ref.current;
		if (!el) return;
		fit(el);
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
		// Paint once when the edit opens. Later keystrokes own the DOM.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const send = () => {
		const next = chips ? readInlineEditor(editorRef.current ?? document.createElement("div")) : draft.trim();
		if (!editableText(next) || busy) return;
		onSend(next);
	};
	return (
		<div className="session-inline-edit" data-testid="copilot-user-message">
			<div className="session-inline-edit-pill">
				{chips ? (
					<div
						ref={editorRef}
						className="session-inline-input"
						role="textbox"
						aria-multiline="true"
						aria-label={t.chat.editQuestion}
						contentEditable={!busy}
						onInput={(event) => setDraft(readInlineEditor(event.currentTarget))}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								onCancel();
								return;
							}
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								send();
							}
						}}
					/>
				) : (
				<textarea
					ref={ref}
					value={draft}
					disabled={busy}
					aria-label={t.chat.editQuestion}
					rows={1}
					onChange={(event) => {
						setDraft(event.target.value);
						fit(event.target);
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							onCancel();
							return;
						}
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							send();
						}
					}}
				/>
				)}
				<div className="session-inline-edit-actions">
					<button type="button" className="session-inline-edit-cancel" aria-label={t.common.cancel} title={t.common.cancel} disabled={busy} onClick={onCancel}>
						<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M18 6 6 18" />
							<path d="m6 6 12 12" />
						</svg>
					</button>
					<button type="button" className="session-inline-edit-send" aria-label={t.chat.send} title={t.chat.send} disabled={busy || !editableText(draft)} onClick={send}>
						<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="m5 12 7-7 7 7" />
							<path d="M12 19V5" />
						</svg>
					</button>
				</div>
			</div>
			{error && <div className="session-branch-note session-branch-error">{error}</div>}
		</div>
	);
}

function messageAssets(entryId: string | undefined, transcript: readonly LoomTranscriptMessage[]): LoomUserAttachment[] {
	if (!entryId) return [];
	const message = transcript.find((row) => row.id === entryId);
	return storedAssetRefs(message && "attachments" in message ? message.attachments : undefined);
}

const SessionUserMessage = ((props: CopilotChatUserMessageProps) => {
	const { t } = useLocale();
	const { branch, stored, transcript } = useChatSession();
	const text = messageText(props.message);
	const entryId = stored.some((message) => message.role === "user" && message.id === props.message.id) ? props.message.id : undefined;
	const assets = displayAssetRefs(text, messageAssets(entryId, transcript));
	const inline = assets.length > 0 || inlineAssetIds(text).length > 0;
	const canEdit = Boolean(branch && entryId && editableText(text) && !branch.busy);
	if (branch && entryId && branch.editingId === entryId) {
		return (
			<InlineEdit
				text={text}
				assets={assets}
				busy={branch.busy}
				error={branch.error}
				onCancel={() => branch.cancelEdit()}
				onSend={(next) => {
					const body = contentWithPlacedAssets(next, placedChips(assets));
					void branch.commitEdit(body);
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

export const SessionMessageView = ((props: CopilotChatMessageViewProps) => (
	<CopilotChatMessageView {...props} assistantMessage={SessionAssistantMessage} userMessage={SessionUserMessage} />
)) as typeof CopilotChatMessageView;

import { useLayoutEffect, useRef, useState } from "react";
import { CopilotChatInput } from "@copilotkit/react-core/v2";
import type { LoomSessionModel, LoomUserAttachment } from "@loom/agent";
import { useLocale } from "../locale.tsx";
import { useOpenAsset } from "./asset-open.tsx";
import { AgentPermissionSelect } from "./agent-permission.tsx";
import { ChatModelSelect } from "./chat-model-select.tsx";
import { editableText } from "./chat-content.ts";
import { paintInlineEditor, readInlineEditor } from "./inline-asset-text.tsx";

export function HistoryMessageEditor({ text, assets, model, busy, error, onCancel, onSend }: {
	text: string;
	assets: readonly LoomUserAttachment[];
	model: LoomSessionModel | undefined;
	busy: boolean;
	error: string | null;
	onCancel: () => void;
	onSend: (text: string, model: LoomSessionModel | undefined) => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const openAsset = useOpenAsset();
	const editor = useRef<HTMLDivElement>(null);
	const [draft, setDraft] = useState(text);
	const [draftModel, setDraftModel] = useState(model);
	useLayoutEffect(() => {
		const element = editor.current;
		if (!element) return;
		paintInlineEditor(element, text, assets, openAsset, { remove: t.common.remove, removeNamed: t.chat.removeNamed });
		element.focus({ preventScroll: true });
		const range = document.createRange();
		range.selectNodeContents(element);
		range.collapse(false);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
		// The editor owns its DOM after opening; history refreshes must not replace the draft.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const send = () => {
		const next = editor.current ? readInlineEditor(editor.current) : draft;
		if (!editableText(next) || busy) return;
		onSend(next, draftModel ?? model);
	};
	return (
		<div className="session-inline-edit" data-testid="copilot-user-message">
			<div className="session-inline-edit-pill">
				<div
					ref={editor}
					className="session-inline-input"
					role="textbox"
					aria-multiline="true"
					aria-label={t.chat.editQuestion}
					aria-disabled={busy}
					contentEditable={!busy}
					suppressContentEditableWarning
					onInput={(event) => setDraft(readInlineEditor(event.currentTarget))}
					onPaste={(event) => {
						const pasted = event.clipboardData.getData("text/plain");
						if (!pasted) return;
						event.preventDefault();
						document.execCommand("insertText", false, pasted);
					}}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (event.key === "Escape") { event.preventDefault(); if (!busy) onCancel(); }
						if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
					}}
				/>
				<div className="session-inline-edit-toolbar">
					<AgentPermissionSelect />
					<ChatModelSelect model={draftModel ?? model} onChange={setDraftModel} disabled={busy} />
					<div className="session-inline-edit-actions">
						<button type="button" className="session-inline-edit-cancel" aria-label={t.common.cancel} data-tooltip={t.common.cancel} disabled={busy} onClick={onCancel}>
							<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M18 6 6 18M6 6l12 12" />
							</svg>
						</button>
						<CopilotChatInput.SendButton className="session-inline-edit-send" aria-label={t.chat.send} data-tooltip={t.chat.send} disabled={busy || !editableText(draft)} onClick={send}>
							<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="m5 12 7-7 7 7M12 19V5" />
							</svg>
						</CopilotChatInput.SendButton>
					</div>
				</div>
			</div>
			{error && <div className="session-branch-note session-branch-error" role="alert">{error}</div>}
		</div>
	);
}

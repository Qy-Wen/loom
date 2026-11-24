import { ComposerForm, isImeComposing } from "@loom/ag-ui-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { LoomSessionModel, LoomUserAttachment } from "@loom/agent";
import { useLocale } from "../locale.tsx";
import { useOpenReference } from "./asset-open.tsx";
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
	const openReference = useOpenReference();
	const editor = useRef<HTMLDivElement>(null);
	const [draft, setDraft] = useState(text);
	const [draftModel, setDraftModel] = useState(model);
	useLayoutEffect(() => {
		const element = editor.current;
		if (!element) return;
		paintInlineEditor(element, text, assets, openReference, { remove: t.common.remove, removeNamed: t.chat.removeNamed });
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
		<div className="session-inline-edit" data-testid="chat-user-message">
			<ComposerForm
				mode="edit"
				onSubmit={send}
				submitDisabled={busy || !editableText(draft)}
				onCancel={onCancel}
				cancelDisabled={busy}
				labels={{ cancel: t.common.cancel, send: t.chat.send }}
				editor={<div
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
						if (isImeComposing(event.nativeEvent)) return;
						if (event.key === "Escape") { event.preventDefault(); if (!busy) onCancel(); }
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							event.currentTarget.closest("form")?.requestSubmit();
						}
					}}
				/>}
				controls={<>
					<AgentPermissionSelect />
					<ChatModelSelect model={draftModel ?? model} onChange={setDraftModel} disabled={busy} />
				</>}
			/>
			{error && <div className="session-branch-note session-branch-error" role="alert">{error}</div>}
		</div>
	);
}

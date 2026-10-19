import { forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CopilotChatInput } from "@copilotkit/react-core/v2";
import { composerLayoutText, stripInlineAssetRefs } from "@loom/agent/composer-asset";
import { useLocale } from "../locale.tsx";
import { ComposerActionsContext } from "./chat-context.ts";
import { paintInlineEditor, placeCaretAtStart, readInlineEditor, type ChipLabels } from "./inline-asset-text.tsx";

export const ComposerTextArea = forwardRef<HTMLTextAreaElement, React.ComponentPropsWithoutRef<typeof CopilotChatInput.TextArea>>(function ComposerTextArea(props, ref) {
	const { t } = useLocale();
	const chipLabels = useRef<ChipLabels>({ remove: t.common.remove, removeNamed: t.chat.removeNamed });
	chipLabels.current = { remove: t.common.remove, removeNamed: t.chat.removeNamed };
	const actions = useContext(ComposerActionsContext);
	const editorRef = useRef<HTMLDivElement>(null);
	const composing = useRef(false);
	const actionsRef = useRef(actions);
	actionsRef.current = actions;
	const setEditor = useCallback((node: HTMLDivElement | null) => {
		editorRef.current = node;
		actionsRef.current?.bindEditor(node);
		if (!node) {
			if (typeof ref === "function") ref(null);
			else if (ref) ref.current = null;
			return;
		}
		if (!Object.getOwnPropertyDescriptor(node, "value")?.get) {
			Object.defineProperty(node, "value", {
				configurable: true,
				get: () => composerLayoutText(readInlineEditor(node)),
				set: (next: string) => {
					const current = readInlineEditor(node);
					if (current === next || composerLayoutText(current) === next) return;
					if (!next && current) return;
					paintInlineEditor(node, next, actionsRef.current?.assets ?? [], (assetId) => actionsRef.current?.openAsset(assetId), chipLabels.current);
				},
			});
		}
		if (typeof ref === "function") ref(node as unknown as HTMLTextAreaElement);
		else if (ref) ref.current = node as unknown as HTMLTextAreaElement;
	}, [ref]);
	useLayoutEffect(() => {
		const editor = editorRef.current;
		if (!editor || composing.current) return;
		const next = String(props.value ?? "");
		const current = readInlineEditor(editor);
		if (current === next) return;
		if (next && composerLayoutText(current) === next) return;
		paintInlineEditor(editor, next, actionsRef.current?.assets ?? [], (assetId) => actionsRef.current?.openAsset(assetId), chipLabels.current);
	}, [props.value]);
	useEffect(() => {
		const editor = editorRef.current;
		if (props.autoFocus) editor?.focus({ preventScroll: true });
	}, [props.autoFocus]);
	const publish = (editor: HTMLDivElement) => {
		props.onChange?.({ target: editor, currentTarget: editor } as unknown as React.ChangeEvent<HTMLTextAreaElement>);
	};
	return (
		<div
			ref={setEditor}
			role="textbox"
			aria-multiline="true"
			data-testid="copilot-chat-textarea"
			data-placeholder={t.chat.placeholder}
			data-empty={String(props.value ?? "") ? "false" : "true"}
			contentEditable
			suppressContentEditableWarning
			className={props.className ? `session-inline-input ${props.className}` : "session-inline-input"}
			style={{ cursor: "text", overflow: "auto", resize: "none", ...props.style }}
			onCompositionStart={(event) => {
				composing.current = true;
				props.onCompositionStart?.(event as unknown as React.CompositionEvent<HTMLTextAreaElement>);
			}}
			onCompositionEnd={(event) => {
				composing.current = false;
				props.onCompositionEnd?.(event as unknown as React.CompositionEvent<HTMLTextAreaElement>);
				publish(event.currentTarget);
			}}
			onInput={(event) => {
				const editor = event.currentTarget;
				const empty = !readInlineEditor(editor);
				editor.dataset.empty = empty ? "true" : "false";
				if (empty) placeCaretAtStart(editor);
				actionsRef.current?.syncAssets();
				if (!composing.current) publish(editor);
			}}
			onFocus={(event) => {
				if (!readInlineEditor(event.currentTarget)) placeCaretAtStart(event.currentTarget);
			}}
			onPaste={(event) => {
				const files = [...event.clipboardData.files];
				if (files.length > 0) {
					event.preventDefault();
					actions?.importFiles(files);
					return;
				}
				const pasted = event.clipboardData.getData("text/plain");
				if (!pasted) return;
				event.preventDefault();
				document.execCommand("insertText", false, pasted);
			}}
			onKeyDown={(event) => {
				const words = stripInlineAssetRefs(readInlineEditor(event.currentTarget)).trim();
				const hasAssets = event.currentTarget.querySelector("[data-asset-id]") !== null;
				if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && actions && hasAssets && !words) {
					event.preventDefault();
					actions.sendAssets();
					return;
				}
				props.onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
			}}
		/>
	);
});

export function AddFilesButton({ className, disabled }: { className?: string; disabled?: boolean; onAddFile?: () => void; toolsMenu?: unknown }): React.JSX.Element {
	const { t } = useLocale();
	const actions = useContext(ComposerActionsContext);
	const rootRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("pointerdown", onPointer);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onPointer);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div ref={rootRef} className="session-add-files-wrap">
			<button
				type="button"
				className={className ? `session-add-files ${className}` : "session-add-files"}
				disabled={disabled}
				aria-label={t.chat.add}
				aria-expanded={open}
				aria-haspopup="menu"
				title={t.chat.add}
				onClick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					setOpen((current) => !current);
				}}
			>
				<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
					<path d="M12 5v14M5 12h14" />
				</svg>
			</button>
			{open && (
				<div className="session-add-files-menu" role="menu">
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							setOpen(false);
							actions?.pickLibrary();
						}}
					>{t.chat.libraryFile}</button>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							setOpen(false);
							actions?.pickExternal();
						}}
					>{t.chat.externalFile}</button>
				</div>
			)}
		</div>
	);
}

export function AssetSendButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
	const actions = useContext(ComposerActionsContext);
	return (
		<CopilotChatInput.SendButton
			{...props}
			disabled={false}
			onClick={(event) => {
				event.preventDefault();
				actions?.sendAssets();
			}}
		/>
	);
}

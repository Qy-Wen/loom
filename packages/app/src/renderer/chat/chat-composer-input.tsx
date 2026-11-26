import { isImeComposing } from "@loom/ag-ui-react";
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { composerLayoutText } from "@loom/agent/composer-asset";
import { useLocale } from "../locale.tsx";
import { ComposerActionsContext } from "./chat-context.ts";
import { paintInlineEditor, placeCaretAtStart, readInlineEditor, type ChipLabels } from "./inline-asset-text.tsx";

export type SlashCommand = "/compact";

export function ComposerTextArea({ value, onChange, commands, onCommand }: {
	value: string;
	onChange: (value: string) => void;
	commands: readonly { command: SlashCommand; label: string; disabled: boolean }[];
	onCommand: (command: SlashCommand) => void;
}) {
	const { t } = useLocale();
	const chipLabels = useRef<ChipLabels>({ remove: t.common.remove, removeNamed: t.chat.removeNamed });
	chipLabels.current = { remove: t.common.remove, removeNamed: t.chat.removeNamed };
	const actions = useContext(ComposerActionsContext);
	const editorRef = useRef<HTMLDivElement>(null);
	const composing = useRef(false);
	const listId = useId();
	const [focused, setFocused] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [highlighted, setHighlighted] = useState<SlashCommand | null>(null);
	const prefix = value.trimStart();
	const matches = focused && !dismissed && prefix.startsWith("/") ? commands.filter(({ command }) => command.startsWith(prefix)) : [];
	const enabled = matches.filter(({ disabled }) => !disabled);
	const active = enabled.find(({ command }) => command === highlighted) ?? enabled[0];
	const optionId = (command: SlashCommand) => `${listId}-${command.slice(1)}`;
	const actionsRef = useRef(actions);
	actionsRef.current = actions;
	const setEditor = useCallback((node: HTMLDivElement | null) => {
		editorRef.current = node;
		actionsRef.current?.bindEditor(node);
	}, []);
	useLayoutEffect(() => {
		const editor = editorRef.current;
		if (!editor || composing.current) return;
		const next = value;
		const current = readInlineEditor(editor);
		if (current === next) return;
		if (next && composerLayoutText(current) === next) return;
		paintInlineEditor(editor, next, actionsRef.current?.assets ?? [], (assetId) => actionsRef.current?.openReference(assetId), chipLabels.current);
	}, [value]);

	function updateDraft(editor: HTMLDivElement) {
		setDismissed(false);
		setHighlighted(null);
		onChange(composerLayoutText(readInlineEditor(editor)));
	}

	function chooseCommand(command: SlashCommand) {
		setDismissed(true);
		setHighlighted(null);
		onCommand(command);
	}

	function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
		if (composing.current || isImeComposing(event.nativeEvent)) return;
		const { key } = event;
		if (matches.length > 0) {
			if (key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setDismissed(true);
				return;
			}
			if (!event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
				if (key === "ArrowUp" || key === "ArrowDown") {
					if (!active) return;
					event.preventDefault();
					const step = key === "ArrowUp" ? -1 : 1;
					const index = (enabled.indexOf(active) + step + enabled.length) % enabled.length;
					setHighlighted(enabled[index]!.command);
					return;
				}
				if (key === "Enter") {
					event.preventDefault();
					if (active && !event.repeat) chooseCommand(active.command);
					return;
				}
			}
		}
		if (key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		event.currentTarget.closest("form")?.requestSubmit();
	}

	return (
		<div className="session-composer-input">
			<div
				ref={setEditor}
				role="textbox"
				aria-multiline="true"
				aria-autocomplete="list"
				aria-haspopup="listbox"
				aria-controls={listId}
				aria-activedescendant={active ? optionId(active.command) : undefined}
				data-testid="chat-composer-editor"
				aria-label={t.chat.placeholder}
				data-placeholder={t.chat.placeholder}
				data-empty={value ? "false" : "true"}
				contentEditable
				suppressContentEditableWarning
				className="session-inline-input"
				onCompositionStart={() => { composing.current = true; }}
				onCompositionEnd={(event) => {
					composing.current = false;
					updateDraft(event.currentTarget);
				}}
				onInput={(event) => {
					const editor = event.currentTarget;
					const empty = !readInlineEditor(editor);
					editor.dataset.empty = empty ? "true" : "false";
					if (empty) placeCaretAtStart(editor);
					actionsRef.current?.syncAssets();
					if (!composing.current) updateDraft(editor);
				}}
				onFocus={(event) => {
					setFocused(true);
					if (!readInlineEditor(event.currentTarget)) placeCaretAtStart(event.currentTarget);
				}}
				onBlur={() => {
					setFocused(false);
					setDismissed(false);
					setHighlighted(null);
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
				onKeyDown={onKeyDown}
			/>
			<ul id={listId} className="session-slash-commands" role="listbox" aria-label={t.chat.slashCommands} hidden={matches.length === 0}>
				{matches.map(({ command, label, disabled }) => (
					<li
						key={command}
						id={optionId(command)}
						role="option"
						aria-selected={active?.command === command}
						aria-disabled={disabled || undefined}
						onMouseDown={(event) => event.preventDefault()}
						onPointerMove={() => { if (!disabled) setHighlighted(command); }}
						onClick={() => { if (!disabled) chooseCommand(command); }}
					>
						<code>{command}</code>
						<span>{label}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

export function AddFilesButton(): React.JSX.Element {
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
				className="session-add-files"
				aria-label={t.chat.add}
				aria-expanded={open}
				aria-haspopup="menu"
				data-tooltip={t.chat.add}
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

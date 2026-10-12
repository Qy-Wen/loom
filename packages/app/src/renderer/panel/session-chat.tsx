import { EventType, type Message } from "@ag-ui/core";
import {
	CopilotChat,
	CopilotChatAssistantMessage,
	CopilotChatInput,
	CopilotChatMessageView,
	CopilotChatUserMessage,
	useAgent,
	type CopilotChatAssistantMessageProps,
	type CopilotChatInputProps,
	type CopilotChatMessageViewProps,
	type CopilotChatUserMessageProps,
	type CopilotChatViewProps,
} from "@copilotkit/react-core/v2";
import { createContext, forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AssetRefAttachment, LoomContextUsage, LoomSessionRecord, LoomTranscriptMessage, LoomUserAttachment } from "@loom/agent";
import { contentWithPlacedAssets } from "@loom/agent/attachments";
import { assetRefBlocks, composerLayoutText, displayAssetRefs, inlineAssetIds, parseComposerAssetInputs, splitStoredAssetText, storedAssetRefs, stripInlineAssetRefs } from "@loom/agent/composer-asset";
import { LOOM_ASSET_DRAG, readAssetDrag } from "../assets/asset-drag.ts";
import { AssistantMarkdown } from "./assistant-asset-text.tsx";
import { adoptMessageId, adoptUserEntryId, freshUserTurn, liveMessagesForSession, mergeChatMessages, toAgUiMessages, transcriptText } from "../../shared/ag-ui-messages.ts";
import { isChatErrorMessageId } from "../../shared/chat-error.ts";
import { useOpenAsset } from "./asset-open.tsx";
import { AgentPermissionSelect } from "./agent-permission.tsx";
import { useLocale } from "../locale.tsx";
import { InlineMessageBody, appendChip, focusInlineEditor, insertChipAtPoint, lookupComposerAsset, paintInlineEditor, placeCaretAtStart, readInlineEditor, rememberComposerAsset, type ChipLabels } from "./inline-asset-text.tsx";

const StoredMessagesContext = createContext<Message[]>([]);
const VisibleMessagesContext = createContext<Message[]>([]);
const ThreadIdContext = createContext("");
const EntryIdsContext = createContext<ReadonlyMap<string, string>>(new Map());
const TranscriptContext = createContext<readonly LoomTranscriptMessage[]>([]);
const ComposerAttachContext = createContext<AssetRefAttachment | null>(null);
const ComposerAttachAppliedContext = createContext<() => void>(() => {});

type ForceView = {
	installedIds: string[];
	display: Message[];
	priorStoredIds: string[];
};

type BranchActions = {
	busy: boolean;
	editingId: string | null;
	error: string | null;
	edit: (entryId: string) => void;
	cancelEdit: () => void;
	fork: (entryId: string, text: string) => void;
	commitEdit: (text: string) => Promise<Message[] | null>;
	deliver: (installed: Message[], text: string) => void;
	bindDeliver: (deliver: (installed: Message[], text: string) => void) => void;
};

const BranchContext = createContext<BranchActions | null>(null);
const ForceContext = createContext<ForceView | null>(null);
const LiveMessagesContext = createContext<readonly Message[]>([]);
const DraftContext = createContext<string | null>(null);
const ClearForceContext = createContext<() => void>(() => {});
const DraftAppliedContext = createContext<() => void>(() => {});
const ContextUsageContext = createContext<LoomContextUsage | null>(null);

type QueuedFollowUp = { text: string; label?: string; seen: number };

type ComposerActions = {
	importFiles: (files: File[]) => void;
	pickLibrary: () => void;
	pickExternal: () => void;
	sendImageOnly: () => void;
	hasAssets: boolean;
	assets: readonly LoomUserAttachment[];
	bindEditor: (editor: HTMLDivElement | null) => void;
	openAsset: (assetId: string) => void;
	syncAssets: () => void;
};

const ComposerActionsContext = createContext<ComposerActions | null>(null);

/**
 * Drop one queued line per new user message with the same text.
 * Survivors remember the current count, so the next render does not spend that message again.
 */
function messageText(message: { content?: unknown }): string {
	return transcriptText(message.content).replaceAll("\u200b", "");
}

function reconcileQueued(items: QueuedFollowUp[], messages: readonly Message[]): QueuedFollowUp[] {
	if (items.length === 0) return items;
	const counts = new Map<string, number>();
	for (const message of messages) {
		if (message.role !== "user") continue;
		const text = messageText(message);
		counts.set(text, (counts.get(text) ?? 0) + 1);
	}
	const removed = new Map<string, number>();
	const next: QueuedFollowUp[] = [];
	let changed = false;
	for (const item of items) {
		const total = counts.get(item.text) ?? 0;
		const arrived = total - item.seen - (removed.get(item.text) ?? 0);
		if (arrived > 0) {
			removed.set(item.text, (removed.get(item.text) ?? 0) + 1);
			changed = true;
			continue;
		}
		const seen = Math.max(item.seen, total);
		if (seen === item.seen) next.push(item);
		else {
			next.push({ ...item, seen });
			changed = true;
		}
	}
	return changed ? next : items;
}

/** Pair visible user bubbles with transcript entry ids, in order, including identical text. */
function userEntryIds(visible: readonly Message[], stored: readonly Message[]): Map<string, string> {
	const storedUsers = stored.filter((message) => message.role === "user" && message.id);
	const map = new Map<string, string>();
	let index = 0;
	for (const message of visible) {
		if (message.role !== "user" || !message.id) continue;
		const match = storedUsers[index];
		if (!match?.id || messageText(match) !== messageText(message)) break;
		map.set(message.id, match.id);
		index += 1;
	}
	return map;
}

function hasPrefixIds(live: readonly Message[], ids: readonly string[]): boolean {
	if (live.length < ids.length) return false;
	for (let index = 0; index < ids.length; index++) {
		if (live[index]?.id !== ids[index]) return false;
	}
	return true;
}

const NEAR_BOTTOM_PX = 48;

function distanceFromBottom(el: HTMLElement): number {
	return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function canScroll(el: HTMLElement): boolean {
	return el.scrollHeight > el.clientHeight + 1;
}

/**
 * Follow new output only while the reader is already at the bottom.
 * A scroll we caused does not count as leaving. Neither does the transcript
 * shrinking until it no longer scrolls: opening another session reuses this
 * view, and the browser clamps scrollTop downward. Scrolling up does, until
 * the reader returns to the bottom or opens another session.
 */
function SessionScrollView({
	children,
	className,
	autoScroll: _autoScroll,
	scrollToBottomButton: _scrollToBottomButton,
	feather: _feather,
	inputContainerHeight: _inputContainerHeight,
	isResizing: _isResizing,
	onScroll,
	...props
}: React.ComponentProps<typeof CopilotChat.View.ScrollView>): React.JSX.Element {
	const { t } = useLocale();
	const threadId = useContext(ThreadIdContext);
	const visible = useContext(VisibleMessagesContext);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const applying = useRef(false);
	const lastTop = useRef(0);
	const touchStartY = useRef<number | null>(null);
	const [away, setAway] = useState(false);
	const [overflowing, setOverflowing] = useState(false);

	const setPinned = useCallback((next: boolean) => {
		pinned.current = next;
		setAway((current) => current === !next ? current : !next);
	}, []);

	const noteOverflow = useCallback((el: HTMLElement) => {
		const next = canScroll(el);
		setOverflowing((current) => current === next ? current : next);
		return next;
	}, []);

	const follow = useCallback(() => {
		const el = scrollerRef.current;
		if (!el) return;
		if (!noteOverflow(el)) {
			lastTop.current = el.scrollTop;
			setPinned(true);
			return;
		}
		if (!pinned.current) return;
		const top = el.scrollHeight;
		if (distanceFromBottom(el) < 1) {
			lastTop.current = el.scrollTop;
			return;
		}
		applying.current = true;
		el.scrollTop = top;
		lastTop.current = el.scrollTop;
		queueMicrotask(() => {
			applying.current = false;
		});
	}, [noteOverflow, setPinned]);

	useLayoutEffect(() => {
		const el = scrollerRef.current;
		if (!el) return;
		const observer = new ResizeObserver(() => follow());
		const watch = () => {
			observer.disconnect();
			const content = el.firstElementChild;
			if (content) observer.observe(content);
		};
		watch();
		follow();
		const mutations = new MutationObserver(watch);
		mutations.observe(el, { childList: true });
		return () => {
			observer.disconnect();
			mutations.disconnect();
		};
	}, [follow]);

	let lastUserId = "";
	for (let index = visible.length - 1; index >= 0; index--) {
		const message = visible[index];
		if (message?.role === "user") {
			lastUserId = message.id;
			break;
		}
	}
	const seenUserId = useRef<string | null>(null);
	useLayoutEffect(() => {
		if (!lastUserId) return;
		if (seenUserId.current === null) {
			seenUserId.current = lastUserId;
			return;
		}
		if (seenUserId.current === lastUserId) return;
		seenUserId.current = lastUserId;
		setPinned(true);
		follow();
	}, [follow, lastUserId, setPinned]);

	useLayoutEffect(() => {
		setPinned(true);
		follow();
	}, [follow, setPinned, threadId]);

	return (
		<div className="session-chat-scroll-host">
			<div
				{...props}
				ref={scrollerRef}
				className={`session-chat-scroll${className ? ` ${className}` : ""}`}
				onWheel={(event) => {
					const el = scrollerRef.current;
					if (!el || event.deltaY >= 0) return;
					if (!canScroll(el)) {
						setPinned(true);
						return;
					}
					setPinned(false);
				}}
				onTouchStart={(event) => {
					touchStartY.current = event.touches[0]?.clientY ?? null;
				}}
				onTouchMove={(event) => {
					const el = scrollerRef.current;
					const start = touchStartY.current;
					const y = event.touches[0]?.clientY;
					if (!el || start === null || y === undefined) return;
					if (!canScroll(el)) {
						setPinned(true);
						return;
					}
					if (y - start > 8) setPinned(false);
				}}
				onScroll={(event) => {
					const el = event.currentTarget;
					const top = el.scrollTop;
					const delta = top - lastTop.current;
					lastTop.current = top;
					// A shrinking transcript clamps scrollTop down. That delta is
					// negative even though the reader is still at the bottom.
					if (!noteOverflow(el) || distanceFromBottom(el) < 1) setPinned(true);
					else if (!applying.current && event.nativeEvent.isTrusted) {
						if (delta < -1) setPinned(false);
						else if (distanceFromBottom(el) < NEAR_BOTTOM_PX) setPinned(true);
					}
					onScroll?.(event);
				}}
			>
				{children}
			</div>
			{away && overflowing ? (
				<button
					type="button"
					className="session-chat-jump"
					onClick={() => {
						setPinned(true);
						follow();
					}}
				>
					{t.chat.latest}
				</button>
			) : null}
		</div>
	);
}

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

function editableText(text: string): boolean {
	return splitStoredAssetText(text).some((part) => part.type === "asset" || part.text.trim().length > 0);
}

function placedChips(rows: readonly LoomUserAttachment[]): AssetRefAttachment[] {
	return rows.filter((row): row is AssetRefAttachment => row.type === "asset_ref");
}

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
	const branch = useContext(BranchContext);
	const entryIds = useContext(EntryIdsContext);
	const transcript = useContext(TranscriptContext);
	const text = messageText(props.message);
	const entryId = entryIds.get(props.message.id);
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
					void branch.commitEdit(body).then((installed) => {
						if (!installed) return;
						branch.deliver(installed, body);
					});
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

const SessionMessageView = ((props: CopilotChatMessageViewProps) => {
	const stored = useContext(StoredMessagesContext);
	const ids = useMemo(() => userEntryIds(props.messages ?? [], stored), [props.messages, stored]);
	return (
		<EntryIdsContext.Provider value={ids}>
			<CopilotChatMessageView {...props} assistantMessage={SessionAssistantMessage} userMessage={SessionUserMessage} />
		</EntryIdsContext.Provider>
	);
}) as typeof CopilotChatMessageView;

const ComposerTextArea = forwardRef<HTMLTextAreaElement, React.ComponentPropsWithoutRef<typeof CopilotChatInput.TextArea>>(function ComposerTextArea(props, ref) {
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
				const words = stripInlineAssetRefs(String(props.value ?? "")).trim();
				if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && actions?.hasAssets && !words) {
					event.preventDefault();
					actions.sendImageOnly();
					return;
				}
				props.onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
			}}
		/>
	);
});

function AddFilesButton({ className, disabled }: { className?: string; disabled?: boolean; onAddFile?: () => void; toolsMenu?: unknown }): React.JSX.Element {
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

function ImageSendButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
	const actions = useContext(ComposerActionsContext);
	return (
		<CopilotChatInput.SendButton
			{...props}
			disabled={false}
			onClick={(event) => {
				event.preventDefault();
				actions?.sendImageOnly();
			}}
		/>
	);
}

/** Enter while a run is active queues a follow-up. Empty input keeps Stop; text or an image restores Send. */
const FollowUpInput = (({ onSubmitMessage, isRunning, onChange, value, ...props }: CopilotChatInputProps) => {
	const { t } = useLocale();
	const chipLabels = useRef<ChipLabels>({ remove: t.common.remove, removeNamed: t.chat.removeNamed });
	chipLabels.current = { remove: t.common.remove, removeNamed: t.chat.removeNamed };
	const threadId = useContext(ThreadIdContext);
	const visible = useContext(VisibleMessagesContext);
	const branch = useContext(BranchContext);
	const force = useContext(ForceContext);
	const live = useContext(LiveMessagesContext);
	const draft = useContext(DraftContext);
	const clearForce = useContext(ClearForceContext);
	const onDraftApplied = useContext(DraftAppliedContext);
	const composerAttach = useContext(ComposerAttachContext);
	const onComposerAttachApplied = useContext(ComposerAttachAppliedContext);
	const { agent } = useAgent();
	const [queued, setQueued] = useState<QueuedFollowUp[]>([]);
	const [assets, setAssets] = useState<LoomUserAttachment[]>([]);
	const [imageError, setImageError] = useState<string | null>(null);
	const assetsRef = useRef(assets);
	assetsRef.current = assets;
	const valueRef = useRef(value);
	valueRef.current = value;
	const transcript = useContext(TranscriptContext);
	const editorRef = useRef<HTMLDivElement | null>(null);
	const openAsset = useOpenAsset();
	const usage = useContext(ContextUsageContext);
	const slotRef = useRef<HTMLDivElement>(null);
	const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		setToolbar(slotRef.current?.querySelector<HTMLElement>('[data-testid="copilot-chat-input"] > [data-layout]') ?? null);
	}, []);
	const hasDraft = editableText(value ?? "") || assets.length > 0;
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	useEffect(() => {
		setAssets([]);
		setQueued([]);
		setImageError(null);
		if (!draftRef.current) onChangeRef.current?.("");
	}, [threadId]);
	const appliedDraft = useRef<string | null>(null);
	const stored = useContext(StoredMessagesContext);
	const handoff = useRef<ReadonlySet<string> | null>(null);
	branch?.bindDeliver((installed, text) => {
		handoff.current = new Set(live.flatMap((message) => message.id ? [message.id] : []));
		agent.setMessages(installed);
		void (async () => {
			const chips = placedChips([
				...assetRefBlocks(text),
				...inlineAssetIds(text).flatMap((id) => {
					const known = assetsRef.current.find((asset) => asset.assetId === id) ?? lookupComposerAsset(id);
					return known && known.type === "asset_ref" ? [known] : [];
				}),
			]);
			if (chips.length > 0 && threadId && typeof window.loom.stageComposerAssets === "function") {
				try {
					await window.loom.stageComposerAssets(threadId, chips.map(({ assetId, path, assetType }) => ({ assetId, path, assetType })));
				} catch (cause) {
					setImageError(cause instanceof Error ? cause.message : t.chat.attachFailed);
				}
			}
			onSubmitMessage?.(contentWithPlacedAssets(text, chips));
		})();
	});

	useEffect(() => {
		if (!draft) {
			appliedDraft.current = null;
			return;
		}
		if (appliedDraft.current === draft) return;
		appliedDraft.current = draft;
		onChange?.(draft);
		onDraftApplied();
	}, [draft, onChange, onDraftApplied]);

	useLayoutEffect(() => {
		if (!composerAttach) return;
		let cancelled = false;
		const run = () => {
			if (cancelled) return;
			const editor = editorRef.current;
			if (!editor) {
				requestAnimationFrame(run);
				return;
			}
			setImageError(null);
			const assetId = composerAttach.assetId;
			try {
				rememberComposerAsset(composerAttach);
				setAssets((current) => current.some((item) => item.assetId === assetId) ? current : [...current, composerAttach]);
				const chip = appendChip(editor, composerAttach, openAsset, chipLabels.current);
				onChange?.(composerLayoutText(readInlineEditor(editor)));
				const activate = () => {
					const current = editorRef.current;
					if (!current?.isConnected) return;
					const node = chip && current.contains(chip)
						? chip
						: current.querySelector(`[data-asset-id="${CSS.escape(assetId)}"]`);
					focusInlineEditor(current, node);
				};
				requestAnimationFrame(() => {
					activate();
					window.setTimeout(activate, 0);
					window.setTimeout(activate, 50);
				});
			} catch (cause) {
				setImageError(cause instanceof Error ? cause.message : t.chat.attachFailed);
			}
			onComposerAttachApplied();
		};
		run();
		return () => {
			cancelled = true;
		};
	}, [composerAttach]);

	useEffect(() => {
		if (!force) {
			handoff.current = null;
			return;
		}
		const beforeIds = handoff.current;
		const prefixReady = force.installedIds.length === 0 || hasPrefixIds(live, force.installedIds);
		const liveSent = !!beforeIds && prefixReady && freshUserTurn(live.slice(force.installedIds.length), beforeIds);
		if (liveSent || freshUserTurn(stored, new Set(force.priorStoredIds))) clearForce();
	}, [clearForce, force, live, stored]);

	useEffect(() => {
		if (!isRunning) {
			setQueued([]);
			return;
		}
		setQueued((items) => reconcileQueued(items, visible));
	}, [isRunning, visible]);

	useEffect(() => {
		for (const message of transcript) {
			if (!("attachments" in message)) continue;
			for (const asset of storedAssetRefs(message.attachments)) rememberComposerAsset(asset);
		}
	}, [transcript]);

	const deliverRef = useRef<(submitted: string) => void>(() => {});
	deliverRef.current = (submitted) => {
		void (async () => {
			const raw = (editorRef.current ? readInlineEditor(editorRef.current) : submitted).replaceAll("\u200b", "");
			const text = editableText(raw) ? raw : "";
			const assetPayload = assetsRef.current;
			if (!text && assetPayload.length === 0) return;
			if (assetPayload.length > 0 && typeof window.loom.stageComposerAssets !== "function") {
				setImageError(threadId ? t.chat.restartToSend : t.chat.openSessionFirst);
				return;
			}
			if (!threadId && assetPayload.length > 0) {
				setImageError(t.chat.openSessionFirst);
				return;
			}
			try {
				if (assetPayload.length > 0) {
					await window.loom.stageComposerAssets(threadId, assetPayload.map(({ assetId, path, assetType }) => ({ assetId, path, assetType })));
				}
			} catch (cause) {
				setImageError(cause instanceof Error ? cause.message : t.chat.attachFailed);
				if (text) onChange?.(text);
				return;
			}
			setAssets([]);
			setImageError(null);
			const body = contentWithPlacedAssets(text, placedChips(assetPayload));
			const runningHere = Boolean(isRunning) && !!threadId && agent.threadId === threadId;
			if (!runningHere) {
				if (threadId && agent.threadId !== threadId) {
					agent.threadId = threadId;
					agent.setMessages([]);
				}
				onSubmitMessage?.(body || "\u200b");
				onChange?.("");
				return;
			}
			const seen = visible.filter((message) => message.role === "user" && messageText(message) === body).length;
			const visibleText = stripInlineAssetRefs(body).trim();
			const label = visibleText || assetPayload.map((asset) => asset.path.split("/").pop() || asset.path).join(", ");
			try {
				await window.loom.followUp(threadId, body);
				setQueued((items) => [...items, { text: body, label, seen }]);
				onChange?.("");
			} catch {
				setAssets(assetPayload);
				if (text) onChange?.(text);
			}
		})();
	};

	async function importDroppedFiles(files: File[]): Promise<void> {
		if (typeof window.loom.importComposerFiles !== "function" || typeof window.loom.pathForFile !== "function") {
			setImageError(t.chat.restartToAttach);
			return;
		}
		const paths: string[] = [];
		for (const file of files) {
			try {
				const path = window.loom.pathForFile(file);
				if (path) paths.push(path);
			} catch {
				// Skip files without a local path.
			}
		}
		if (paths.length === 0) {
			setImageError(t.chat.readFailed);
			return;
		}
		try {
			const picked = await window.loom.importComposerFiles(paths);
			if (picked.length === 0) return;
			appendAssets(picked.map((asset) => ({
				type: "asset_ref",
				assetId: asset.assetId,
				path: asset.path,
				assetType: asset.assetType,
			})));
		} catch (cause) {
			setImageError(cause instanceof Error ? cause.message : t.chat.attachFailed);
		}
	}

	function appendAssets(items: LoomUserAttachment[]): void {
		const parsed = parseComposerAssetInputs(items);
		if (parsed.length === 0) return;
		setImageError(null);
		const editor = editorRef.current;
		for (const asset of parsed) {
			rememberComposerAsset(asset);
			if (editor) appendChip(editor, asset, openAsset, chipLabels.current);
		}
		setAssets((current) => {
			const next = [...current];
			for (const asset of parsed) {
				if (!next.some((item) => item.assetId === asset.assetId)) next.push(asset);
			}
			return next;
		});
		if (editor) onChange?.(composerLayoutText(readInlineEditor(editor)));
		const last = parsed.at(-1);
		const activate = () => {
			const current = editorRef.current;
			if (!current?.isConnected || !last) return;
			const node = current.querySelector(`[data-asset-id="${CSS.escape(last.assetId)}"]`);
			focusInlineEditor(current, node);
		};
		requestAnimationFrame(() => {
			activate();
			window.setTimeout(activate, 0);
			window.setTimeout(activate, 50);
		});
	}

	async function pickLibraryFiles(): Promise<void> {
		if (typeof window.loom.pickComposerLibraryAssets !== "function") {
			setImageError(t.chat.restartToAttachLibrary);
			return;
		}
		try {
			const picked = await window.loom.pickComposerLibraryAssets();
			if (picked.length === 0) return;
			appendAssets(picked.map((asset) => ({
				type: "asset_ref",
				assetId: asset.assetId,
				path: asset.path,
				assetType: asset.assetType,
			})));
		} catch (cause) {
			setImageError(cause instanceof Error ? cause.message : t.chat.attachFailed);
		}
	}

	async function pickExternalFiles(): Promise<void> {
		if (typeof window.loom.pickComposerExternalFiles !== "function") {
			setImageError(t.chat.restartToAttach);
			return;
		}
		try {
			const picked = await window.loom.pickComposerExternalFiles();
			if (picked.length === 0) return;
			appendAssets(picked.map((asset) => ({
				type: "asset_ref",
				assetId: asset.assetId,
				path: asset.path,
				assetType: asset.assetType,
			})));
		} catch (cause) {
			setImageError(cause instanceof Error ? cause.message : t.chat.attachFailed);
		}
	}

	function placeAsset(value: unknown, x: number, y: number): void {
		setImageError(null);
		try {
			const asset = parseComposerAssetInputs([value])[0];
			if (!asset) return;
			rememberComposerAsset(asset);
			setAssets((current) => current.some((item) => item.assetId === asset.assetId) ? current : [...current, asset]);
			const editor = editorRef.current;
			const placed = editor ? insertChipAtPoint(editor, asset, x, y, openAsset, chipLabels.current) : false;
			if (placed && editor) onChange?.(composerLayoutText(readInlineEditor(editor)));
			else onChange?.(`${valueRef.current ?? ""} `);
		} catch (cause) {
			setImageError(cause instanceof Error ? cause.message : t.chat.attachFailed);
		}
	}

	const composerActions: ComposerActions = {
		importFiles: (files) => { void importDroppedFiles(files); },
		pickLibrary: () => { void pickLibraryFiles(); },
		pickExternal: () => { void pickExternalFiles(); },
		sendImageOnly: () => deliverRef.current((valueRef.current ?? "").trim() || "\u200b"),
		hasAssets: assets.length > 0,
		assets,
		bindEditor: (editor) => {
			editorRef.current = editor;
		},
		openAsset,
		syncAssets: () => {
			const editor = editorRef.current;
			if (!editor) {
				setAssets([]);
				return;
			}
			const next: LoomUserAttachment[] = [];
			const seen = new Set<string>();
			for (const node of editor.querySelectorAll<HTMLElement>("[data-asset-id]")) {
				const id = node.dataset.assetId;
				if (!id || seen.has(id)) continue;
				seen.add(id);
				const known = lookupComposerAsset(id);
				if (known) next.push(known);
			}
			setAssets(next);
		},
	};

	return (
		<ComposerActionsContext.Provider value={composerActions}>
		<div
			ref={slotRef}
			className="session-follow-up-slot"
			onDragOver={(event) => {
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}}
			onDrop={(event) => {
				if ([...event.dataTransfer.types].includes(LOOM_ASSET_DRAG)) {
					event.preventDefault();
					try {
						const dropped = readAssetDrag(event.dataTransfer);
						if (dropped) placeAsset(dropped, event.clientX, event.clientY);
					} catch {
						setImageError(t.chat.attachFailed);
					}
					return;
				}
				const files = [...event.dataTransfer.files];
				if (files.length === 0) return;
				event.preventDefault();
				void importDroppedFiles(files);
			}}
		>
			{branch?.error && !branch.editingId && <div className="session-branch-note session-branch-error">{branch.error}</div>}
			{imageError && <div className="session-branch-note session-branch-error">{imageError}</div>}
			{queued.length > 0 && (
				<section className="session-follow-up" aria-label={t.chat.queued}>
					<div className="session-follow-up-label">{t.chat.queued}</div>
					<ol>
						{queued.map((item, index) => (
							<li key={`${index}:${item.label ?? item.text}`}>{item.label || item.text}</li>
						))}
					</ol>
				</section>
			)}
			<div>
				{toolbar && createPortal(
					<div className="session-composer-meta" onMouseDown={(event) => event.stopPropagation()}>
						<AgentPermissionSelect />
						<ContextIndicator context={usage} />
					</div>,
					toolbar,
				)}
				<CopilotChatInput
					{...props}
					value={value}
					isRunning={Boolean(isRunning) && !hasDraft}
					showDisclaimer={false}
					onChange={onChange}
					toolsMenu={[
						{ label: t.chat.addLibraryFile, action: () => { void pickLibraryFiles(); } },
						{ label: t.chat.addExternalFile, action: () => { void pickExternalFiles(); } },
					]}
					addMenuButton={AddFilesButton}
					textArea={ComposerTextArea}
					sendButton={assets.length > 0 ? ImageSendButton : undefined}
					onSubmitMessage={(submitted) => {
						deliverRef.current(submitted);
					}}
				/>
			</div>
		</div>
		</ComposerActionsContext.Provider>
	);
}) as typeof CopilotChatInput;

/** Stable slot so CopilotChat does not remount the view on every parent render. */
function SessionChatView(props: CopilotChatViewProps): React.JSX.Element {
	const stored = useContext(StoredMessagesContext);
	const force = useContext(ForceContext);
	const threadId = useContext(ThreadIdContext);
	const { agent } = useAgent({ updates: [] });
	const seenThread = useRef<string | null>(null);
	const skippedLive = useRef<readonly Message[] | null>(null);
	const rawLive = props.messages ?? [];
	// Hide the previous thread's array until the agent replaces it.
	if (seenThread.current !== threadId) {
		if (seenThread.current !== null) skippedLive.current = rawLive;
		seenThread.current = threadId;
	}
	const live = liveMessagesForSession(threadId, agent.threadId, rawLive, skippedLive.current);
	const messages = useMemo(
		() => (force ? force.display : mergeChatMessages(stored, live)),
		[force, stored, live],
	);
	return (
		<VisibleMessagesContext.Provider value={messages}>
			<LiveMessagesContext.Provider value={live}>
			<CopilotChat.View
				{...props}
				messages={messages}
				scrollView={SessionScrollView}
				messageView={SessionMessageView}
				input={FollowUpInput}
			/>
			</LiveMessagesContext.Provider>
		</VisibleMessagesContext.Provider>
	);
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

/** Context usage as a ring. The percent and window appear only after a click. */
function ContextIndicator({ context }: { context: LoomContextUsage | null }): React.JSX.Element | null {
	const { t } = useLocale();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
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
	if (!context) return null;
	const ratio = context.percent === null ? 0 : Math.min(100, Math.max(0, context.percent)) / 100;
	const radius = 6;
	const circumference = 2 * Math.PI * radius;
	const label = context.percent !== null
		? `${context.percent.toFixed(1)}% / ${formatTokens(context.window)}`
		: `? / ${formatTokens(context.window)}`;
	return (
		<div className="session-context-usage" ref={rootRef}>
			{open && <span className="session-context-value">{label}</span>}
			<button
				type="button"
				className="session-context-ring"
				aria-label={t.chat.contextUsage}
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
			>
				<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
					<circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.25" />
					<circle
						cx="8"
						cy="8"
						r={radius}
						fill="none"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeDasharray={`${circumference * ratio} ${circumference}`}
						transform="rotate(-90 8 8)"
					/>
				</svg>
			</button>
		</div>
	);
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** Draw committed durable history through CopilotChat.View without writing into its agent. */
export function SessionChat({
	threadId,
	messages,
	context,
	composerDraft,
	onComposerDraftApplied,
	composerAttach,
	onComposerAttachApplied,
	onSessionRecord,
	onForked,
}: {
	threadId: string;
	messages: LoomTranscriptMessage[];
	context: LoomContextUsage | null;
	composerDraft: string | null;
	onComposerDraftApplied: () => void;
	composerAttach: AssetRefAttachment | null;
	onComposerAttachApplied: () => void;
	onSessionRecord: (record: LoomSessionRecord) => void;
	onForked: (record: LoomSessionRecord, draft: string) => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const stored = useMemo(() => toAgUiMessages(messages), [messages]);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [force, setForce] = useState<ForceView | null>(null);
	const editingRef = useRef<string | null>(null);
	const storedIds = useRef<string[]>([]);
	storedIds.current = stored.flatMap((message) => message.id ? [message.id] : []);
	const deliverRef = useRef<(installed: Message[], text: string) => void>(() => {});
	const onRecord = useRef(onSessionRecord);
	const onFork = useRef(onForked);
	onRecord.current = onSessionRecord;
	onFork.current = onForked;
	const clearForce = useCallback(() => setForce(null), []);
	const { agent } = useAgent({ updates: [] });
	useEffect(() => {
		const subscription = agent.subscribe({
			onCustomEvent({ event, messages }) {
				const value = event.value;
				const entryId = value && typeof value === "object" && "entryId" in value && typeof value.entryId === "string" ? value.entryId : "";
				if (!entryId) return;
				if (event.name === "loom.user_entry") {
					const next = adoptUserEntryId(messages, entryId);
					if (!next) return;
					return { messages: next };
				}
				if (event.name !== "loom.adopt_entry") return;
				const fromId = value && typeof value === "object" && "fromId" in value && typeof value.fromId === "string" ? value.fromId : "";
				if (!fromId) return;
				const next = adoptMessageId(messages, fromId, entryId);
				if (!next) return;
				return { messages: next };
			},
		});
		return () => subscription.unsubscribe();
	}, [agent]);

	useEffect(() => {
		editingRef.current = null;
		setEditingId(null);
		setError(null);
		setForce(null);
		setBusy(false);
	}, [threadId]);

	const actions = useMemo<BranchActions>(() => ({
		busy,
		editingId,
		error,
		bindDeliver(next) {
			deliverRef.current = next;
		},
		deliver(installed, text) {
			deliverRef.current(installed, text);
		},
		edit(entryId) {
			editingRef.current = entryId;
			setEditingId(entryId);
			setError(null);
		},
		cancelEdit() {
			editingRef.current = null;
			setEditingId(null);
			setError(null);
		},
		async fork(entryId, text) {
			setBusy(true);
			setError(null);
			try {
				const record = await window.loom.forkBefore(threadId, entryId);
				onFork.current(record, text);
			} catch (cause) {
				setError(errorText(cause));
			} finally {
				setBusy(false);
			}
		},
		async commitEdit(text) {
			const entryId = editingRef.current;
			if (!entryId) return null;
			const priorStoredIds = storedIds.current;
			setBusy(true);
			setError(null);
			try {
				const record = await window.loom.branchBefore(threadId, entryId);
				const installed = toAgUiMessages(record.messages);
				const display: Message[] = [...installed, { id: "loom-branch-pending", role: "user", content: text }];
				editingRef.current = null;
				setEditingId(null);
				setForce({ installedIds: installed.map((message) => message.id), display, priorStoredIds });
				onRecord.current(record);
				return installed;
			} catch (cause) {
				setError(errorText(cause));
				return null;
			} finally {
				setBusy(false);
			}
		},
	}), [busy, editingId, error, threadId]);

	return (
		<TranscriptContext.Provider value={messages}>
		<StoredMessagesContext.Provider value={stored}>
			<ThreadIdContext.Provider value={threadId}>
			<BranchContext.Provider value={actions}>
			<ForceContext.Provider value={force}>
			<ClearForceContext.Provider value={clearForce}>
			<DraftContext.Provider value={composerDraft}>
			<DraftAppliedContext.Provider value={onComposerDraftApplied}>
			<ComposerAttachContext.Provider value={composerAttach}>
			<ComposerAttachAppliedContext.Provider value={onComposerAttachApplied}>
			<ContextUsageContext.Provider value={context}>
			<div className="session-chat-shell">
				<CopilotChat threadId={threadId} welcomeScreen={false} chatView={SessionChatView} labels={{ chatInputToolbarAddButtonLabel: t.chat.add }} />
			</div>
			</ContextUsageContext.Provider>
			</ComposerAttachAppliedContext.Provider>
			</ComposerAttachContext.Provider>
			</DraftAppliedContext.Provider>
			</DraftContext.Provider>
			</ClearForceContext.Provider>
			</ForceContext.Provider>
			</BranchContext.Provider>
			</ThreadIdContext.Provider>
		</StoredMessagesContext.Provider>
		</TranscriptContext.Provider>
	);
}

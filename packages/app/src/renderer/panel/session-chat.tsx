import type { Message } from "@ag-ui/core";
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
import type { HarnessContextUsage, HarnessSessionRecord, LoomTranscriptMessage, UiSelectionAttachment } from "@loom/agent";
import { composerLayoutText, inlineAssetIds, parseComposerAssetInputs, storedAssetRefs, stripInlineAssetRefs } from "@loom/agent/composer-asset";
import { bytesToBase64, COMPOSER_IMAGE_MAX_BYTES, COMPOSER_IMAGE_MAX_COUNT, sniffComposerImage, type ComposerImageMime } from "@loom/agent/composer-image";
import { LOOM_ASSET_DRAG, readAssetDrag } from "../assets/asset-drag.ts";
import { mergeChatMessages, toAgUiMessages, transcriptText } from "../../shared/ag-ui-messages.ts";
import { isChatErrorMessageId } from "../../shared/chat-error.ts";
import { useOpenAsset } from "./asset-open.tsx";
import { InlineMessageBody, appendChip, focusInlineEditor, insertChipAtPoint, lookupComposerAsset, paintInlineEditor, placeCaretAtStart, readInlineEditor, rememberComposerAsset } from "./inline-asset-text.tsx";

const StoredMessagesContext = createContext<Message[]>([]);
const VisibleMessagesContext = createContext<Message[]>([]);
const ThreadIdContext = createContext("");
const EntryIdsContext = createContext<ReadonlyMap<string, string>>(new Map());
const TranscriptContext = createContext<readonly LoomTranscriptMessage[]>([]);
const ComposerAttachContext = createContext<UiSelectionAttachment | null>(null);
const ComposerAttachAppliedContext = createContext<() => void>(() => {});

type ForceView = {
	installedIds: string[];
	display: Message[];
	sentText: string;
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

type QueuedFollowUp = { text: string; label?: string; seen: number };

type PendingImage = {
	id: string;
	filename: string;
	mimeType: ComposerImageMime;
	data: string;
	preview: string;
};

type ComposerActions = {
	addFiles: (files: File[]) => void;
	sendImageOnly: () => void;
	hasImages: boolean;
	hasAssets: boolean;
	assets: readonly UiSelectionAttachment[];
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

/**
 * Instant snap-to-bottom on mount. CopilotChat's default ScrollView first paints
 * at the top, then animates down (visible when switching sessions).
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
	const ref = useRef<HTMLDivElement>(null);
	const stick = useRef(true);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const snap = () => {
			if (stick.current) el.scrollTop = el.scrollHeight;
		};
		snap();
		const observer = new ResizeObserver(snap);
		observer.observe(el);
		if (el.firstElementChild) observer.observe(el.firstElementChild);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			{...props}
			ref={ref}
			className={`session-chat-scroll${className ? ` ${className}` : ""}`}
			onScroll={(event) => {
				const el = event.currentTarget;
				stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
				onScroll?.(event);
			}}
		>
			{children}
		</div>
	);
}

const SessionAssistantMessage = ((props: CopilotChatAssistantMessageProps) => {
	if (isChatErrorMessageId(props.message.id)) {
		const text = typeof props.message.content === "string" ? props.message.content : "";
		return (
			<div className="chat-error" role="alert">
				<div className="chat-error-label">Request failed</div>
				<p className="chat-error-body">{text}</p>
			</div>
		);
	}
	return <CopilotChatAssistantMessage {...props} />;
}) as typeof CopilotChatAssistantMessage;

function editableText(text: string): boolean {
	return stripInlineAssetRefs(text).trim().length > 0 || inlineAssetIds(text).length > 0;
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
	assets: readonly UiSelectionAttachment[];
	busy: boolean;
	error: string | null;
	onCancel: () => void;
	onSend: (text: string) => void;
}): React.JSX.Element {
	const openAsset = useOpenAsset();
	const ref = useRef<HTMLTextAreaElement>(null);
	const editorRef = useRef<HTMLDivElement>(null);
	const chips = inlineAssetIds(text).length > 0;
	const [draft, setDraft] = useState(text);
	const fit = (el: HTMLTextAreaElement) => {
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	};
	useLayoutEffect(() => {
		if (chips) {
			const editor = editorRef.current;
			if (!editor) return;
			paintInlineEditor(editor, text, assets, openAsset);
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
						aria-label="Edit question"
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
					aria-label="Edit question"
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
					<button type="button" className="session-inline-edit-cancel" aria-label="Cancel" title="Cancel" disabled={busy} onClick={onCancel}>
						<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M18 6 6 18" />
							<path d="m6 6 12 12" />
						</svg>
					</button>
					<button type="button" className="session-inline-edit-send" aria-label="Send" title="Send" disabled={busy || !editableText(draft)} onClick={send}>
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

function messageAssets(entryId: string | undefined, transcript: readonly LoomTranscriptMessage[]): UiSelectionAttachment[] {
	if (!entryId) return [];
	const message = transcript.find((row) => row.id === entryId);
	return storedAssetRefs(message && "attachments" in message ? message.attachments : undefined);
}

const SessionUserMessage = ((props: CopilotChatUserMessageProps) => {
	const branch = useContext(BranchContext);
	const entryIds = useContext(EntryIdsContext);
	const transcript = useContext(TranscriptContext);
	const text = messageText(props.message);
	const entryId = entryIds.get(props.message.id);
	const assets = messageAssets(entryId, transcript);
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
					void branch.commitEdit(next).then((installed) => {
						if (!installed) return;
						branch.deliver(installed, next);
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
				<CopilotChatUserMessage.ToolbarButton title="Fork" onClick={() => branch!.fork(entryId!, text)}>
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
					paintInlineEditor(node, next, actionsRef.current?.assets ?? [], (assetId) => actionsRef.current?.openAsset(assetId));
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
		paintInlineEditor(editor, next, actionsRef.current?.assets ?? [], (assetId) => actionsRef.current?.openAsset(assetId));
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
			data-placeholder="Type a message..."
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
					actions?.addFiles(files);
					return;
				}
				const pasted = event.clipboardData.getData("text/plain");
				if (!pasted) return;
				event.preventDefault();
				document.execCommand("insertText", false, pasted);
			}}
			onKeyDown={(event) => {
				const words = stripInlineAssetRefs(String(props.value ?? "")).trim();
				if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (actions?.hasImages || actions?.hasAssets) && !words) {
					event.preventDefault();
					actions.sendImageOnly();
					return;
				}
				props.onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
			}}
		/>
	);
});

function AddFilesButton({ onAddFile, toolsMenu: _toolsMenu, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { onAddFile?: () => void; toolsMenu?: unknown }): React.JSX.Element {
	return (
		<button
			type="button"
			{...props}
			className={className ? `session-add-files ${className}` : "session-add-files"}
			aria-label="Add files"
			title="Add files"
			onClick={(event) => {
				props.onClick?.(event);
				if (event.defaultPrevented) return;
				event.preventDefault();
				onAddFile?.();
			}}
		>
			<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
				<path d="M12 5v14M5 12h14" />
			</svg>
		</button>
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
	const [images, setImages] = useState<PendingImage[]>([]);
	const [assets, setAssets] = useState<UiSelectionAttachment[]>([]);
	const [imageError, setImageError] = useState<string | null>(null);
	const imagesRef = useRef(images);
	imagesRef.current = images;
	const assetsRef = useRef(assets);
	assetsRef.current = assets;
	const valueRef = useRef(value);
	valueRef.current = value;
	const fileRef = useRef<HTMLInputElement>(null);
	const transcript = useContext(TranscriptContext);
	const editorRef = useRef<HTMLDivElement | null>(null);
	const openAsset = useOpenAsset();
	const hasDraft = editableText(value ?? "") || images.length > 0 || assets.length > 0;
	const appliedDraft = useRef<string | null>(null);
	const emptySeen = useRef(false);
	const forceSeen = useRef<ForceView | null>(null);
	branch?.bindDeliver((installed, text) => {
		agent.setMessages(installed);
		void (async () => {
			const ids = [...new Set(inlineAssetIds(text))];
			if (ids.length > 0 && threadId && typeof window.loom.stageComposerAssets === "function") {
				const chips = ids.flatMap((id) => {
					const known = assetsRef.current.find((asset) => asset.assetId === id) ?? lookupComposerAsset(id);
					return known ? [known] : [];
				});
				if (chips.length > 0) {
					try {
						await window.loom.stageComposerAssets(threadId, chips.map(({ assetId, path, assetType }) => ({ assetId, path, assetType })));
					} catch (cause) {
						setImageError(cause instanceof Error ? cause.message : "Could not attach that file.");
					}
				}
			}
			onSubmitMessage?.(text);
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
				const chip = appendChip(editor, composerAttach, openAsset);
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
				setImageError(cause instanceof Error ? cause.message : "Could not attach that file.");
			}
			onComposerAttachApplied();
		};
		run();
		return () => {
			cancelled = true;
		};
	}, [composerAttach]);

	useEffect(() => {
		if (forceSeen.current !== force) {
			forceSeen.current = force;
			emptySeen.current = false;
		}
		if (!force) return;
		if (force.installedIds.length === 0) {
			if (live.length === 0) emptySeen.current = true;
			if (!emptySeen.current) return;
			if (live[0]?.role === "user" && messageText(live[0]) === force.sentText) clearForce();
			return;
		}
		if (!hasPrefixIds(live, force.installedIds)) return;
		const extra = live.slice(force.installedIds.length);
		if (extra.some((message) => message.role === "user" && messageText(message) === force.sentText)) clearForce();
	}, [clearForce, force, live]);

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
			const text = stripInlineAssetRefs(raw).trim() || inlineAssetIds(raw).length > 0 ? raw : "";
			const payload = imagesRef.current;
			const assetPayload = assetsRef.current;
			if (!text && payload.length === 0 && assetPayload.length === 0) return;
			if ((payload.length > 0 && typeof window.loom.stageComposerImages !== "function") || (assetPayload.length > 0 && typeof window.loom.stageComposerAssets !== "function")) {
				setImageError(threadId ? "Restart the app to send attachments." : "Open a session before attaching a file.");
				return;
			}
			if (!threadId && (payload.length > 0 || assetPayload.length > 0)) {
				setImageError("Open a session before attaching a file.");
				return;
			}
			try {
				if (payload.length > 0) {
					await window.loom.stageComposerImages(threadId, payload.map(({ filename, mimeType, data }) => ({ filename, mimeType, data })));
				}
				if (assetPayload.length > 0) {
					await window.loom.stageComposerAssets(threadId, assetPayload.map(({ assetId, path, assetType }) => ({ assetId, path, assetType })));
				}
			} catch (cause) {
				setImageError(cause instanceof Error ? cause.message : "Could not attach that file.");
				if (text) onChange?.(text);
				return;
			}
			setImages([]);
			setAssets([]);
			setImageError(null);
			if (!isRunning || !threadId) {
				onSubmitMessage?.(text || "\u200b");
				onChange?.("");
				return;
			}
			const seen = visible.filter((message) => message.role === "user" && messageText(message) === text).length;
			const visibleText = stripInlineAssetRefs(text).trim();
			const label = visibleText || [...payload.map((image) => image.filename), ...assetPayload.map((asset) => asset.path.split("/").pop() || asset.path)].join(", ");
			try {
				await window.loom.followUp(threadId, text);
				setQueued((items) => [...items, { text, label, seen }]);
				onChange?.("");
			} catch {
				setImages(payload);
				setAssets(assetPayload);
				if (text) onChange?.(text);
			}
		})();
	};

	async function addFiles(files: File[]): Promise<void> {
		setImageError(null);
		const next = [...imagesRef.current];
		let error: string | null = null;
		for (const file of files) {
			if (next.length >= COMPOSER_IMAGE_MAX_COUNT) {
				error = "Attach up to 4 images.";
				break;
			}
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				const mimeType = sniffComposerImage(bytes);
				if (!mimeType) {
					error = "Use a JPEG, PNG, GIF, or WebP image.";
					continue;
				}
				if (bytes.byteLength > COMPOSER_IMAGE_MAX_BYTES) {
					error = "Each image must be 8 MB or smaller.";
					continue;
				}
				const data = bytesToBase64(bytes);
				next.push({
					id: crypto.randomUUID(),
					filename: file.name || "image",
					mimeType,
					data,
					preview: `data:${mimeType};base64,${data}`,
				});
			} catch {
				error = "Could not read that image.";
			}
		}
		setImages(next);
		if (error) setImageError(error);
	}

	function placeAsset(value: unknown, x: number, y: number): void {
		setImageError(null);
		try {
			const asset = parseComposerAssetInputs([value])[0];
			if (!asset) return;
			rememberComposerAsset(asset);
			setAssets((current) => current.some((item) => item.assetId === asset.assetId) ? current : [...current, asset]);
			const editor = editorRef.current;
			const placed = editor ? insertChipAtPoint(editor, asset, x, y, openAsset) : false;
			if (placed && editor) onChange?.(composerLayoutText(readInlineEditor(editor)));
			else onChange?.(`${valueRef.current ?? ""} `);
		} catch (cause) {
			setImageError(cause instanceof Error ? cause.message : "Could not attach that file.");
		}
	}

	const composerActions: ComposerActions = {
		addFiles: (files) => { void addFiles(files); },
		sendImageOnly: () => deliverRef.current((valueRef.current ?? "").trim() || "\u200b"),
		hasImages: images.length > 0,
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
			const next: UiSelectionAttachment[] = [];
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
						setImageError("Could not attach that file.");
					}
					return;
				}
				const files = [...event.dataTransfer.files];
				if (files.length === 0) return;
				event.preventDefault();
				void addFiles(files);
			}}
		>
			{branch?.error && !branch.editingId && <div className="session-branch-note session-branch-error">{branch.error}</div>}
			{imageError && <div className="session-branch-note session-branch-error">{imageError}</div>}
			{queued.length > 0 && (
				<section className="session-follow-up" aria-label="Queued">
					<div className="session-follow-up-label">Queued</div>
					<ol>
						{queued.map((item, index) => (
							<li key={`${index}:${item.label ?? item.text}`}>{item.label || item.text}</li>
						))}
					</ol>
				</section>
			)}
			<input
				ref={fileRef}
				type="file"
				accept="image/jpeg,image/png,image/gif,image/webp,.jpg,.jpeg,.png,.gif,.webp"
				multiple
				hidden
				onChange={(event) => {
					const files = [...event.target.files ?? []];
					event.target.value = "";
					if (files.length > 0) void addFiles(files);
				}}
			/>
			<div className={images.length > 0 ? "session-composer-box" : undefined}>
				{images.length > 0 && (
					<div className="session-composer-images">
						{images.map((image) => (
							<div key={image.id} className="session-composer-image">
								<img src={image.preview} alt={image.filename} />
								<button type="button" aria-label={`Remove ${image.filename}`} onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}>×</button>
							</div>
						))}
					</div>
				)}
				<CopilotChatInput
					{...props}
					value={value}
					isRunning={Boolean(isRunning) && !hasDraft}
					showDisclaimer={false}
					onChange={onChange}
					onAddFile={() => fileRef.current?.click()}
					addMenuButton={AddFilesButton}
					textArea={ComposerTextArea}
					sendButton={images.length > 0 || assets.length > 0 ? ImageSendButton : undefined}
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
	const live = props.messages ?? [];
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

/** Context usage indicator, e.g. 12.5%/1.0M; "?" after compaction until the next response. */
function ContextIndicator({ context }: { context: HarnessContextUsage | null }): React.JSX.Element | null {
	if (!context) return null;
	const percent = context.percent !== null ? `${context.percent.toFixed(1)}%` : "?";
	return (
		<div className="session-context-usage" title="Share of the model context window in use">
			{percent}/{formatTokens(context.window)}
		</div>
	);
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** Draw JSONL history through CopilotChat.View without writing into its agent. */
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
	context: HarnessContextUsage | null;
	composerDraft: string | null;
	onComposerDraftApplied: () => void;
	composerAttach: UiSelectionAttachment | null;
	onComposerAttachApplied: () => void;
	onSessionRecord: (record: HarnessSessionRecord) => void;
	onForked: (record: HarnessSessionRecord, draft: string) => void;
}): React.JSX.Element {
	const stored = useMemo(() => toAgUiMessages(messages), [messages]);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [force, setForce] = useState<ForceView | null>(null);
	const editingRef = useRef<string | null>(null);
	const deliverRef = useRef<(installed: Message[], text: string) => void>(() => {});
	const onRecord = useRef(onSessionRecord);
	const onFork = useRef(onForked);
	onRecord.current = onSessionRecord;
	onFork.current = onForked;
	const clearForce = useCallback(() => setForce(null), []);

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
			setBusy(true);
			setError(null);
			try {
				const record = await window.loom.branchBefore(threadId, entryId);
				const installed = toAgUiMessages(record.messages);
				const display: Message[] = [...installed, { id: "loom-branch-pending", role: "user", content: text }];
				editingRef.current = null;
				setEditingId(null);
				setForce({ installedIds: installed.map((message) => message.id), display, sentText: text });
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
			<div className="session-chat-shell">
				<CopilotChat key={threadId} threadId={threadId} chatView={SessionChatView} labels={{ chatInputToolbarAddButtonLabel: "Add files" }} />
				<ContextIndicator context={context} />
			</div>
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

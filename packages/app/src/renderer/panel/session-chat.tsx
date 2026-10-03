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
import type { HarnessContextUsage, HarnessSessionRecord, LoomTranscriptMessage } from "@loom/agent";
import { bytesToBase64, COMPOSER_IMAGE_MAX_BYTES, COMPOSER_IMAGE_MAX_COUNT, sniffComposerImage, type ComposerImageMime } from "@loom/agent/composer-image";
import { mergeChatMessages, toAgUiMessages, transcriptText } from "../../shared/ag-ui-messages.ts";
import { isChatErrorMessageId } from "../../shared/chat-error.ts";

const StoredMessagesContext = createContext<Message[]>([]);
const VisibleMessagesContext = createContext<Message[]>([]);
const ThreadIdContext = createContext("");
const EntryIdsContext = createContext<ReadonlyMap<string, string>>(new Map());

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

function InlineEdit({
	text,
	busy,
	error,
	onCancel,
	onSend,
}: {
	text: string;
	busy: boolean;
	error: string | null;
	onCancel: () => void;
	onSend: (text: string) => void;
}): React.JSX.Element {
	const ref = useRef<HTMLTextAreaElement>(null);
	const [draft, setDraft] = useState(text);
	const fit = (el: HTMLTextAreaElement) => {
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	};
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		fit(el);
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}, []);
	const send = () => {
		const next = draft.trim();
		if (!next || busy) return;
		onSend(next);
	};
	return (
		<div className="session-inline-edit" data-testid="copilot-user-message">
			<div className="session-inline-edit-pill">
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
				<div className="session-inline-edit-actions">
					<button type="button" className="session-inline-edit-cancel" aria-label="Cancel" title="Cancel" disabled={busy} onClick={onCancel}>
						<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M18 6 6 18" />
							<path d="m6 6 12 12" />
						</svg>
					</button>
					<button type="button" className="session-inline-edit-send" aria-label="Send" title="Send" disabled={busy || draft.trim().length === 0} onClick={send}>
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

const SessionUserMessage = ((props: CopilotChatUserMessageProps) => {
	const branch = useContext(BranchContext);
	const entryIds = useContext(EntryIdsContext);
	const text = messageText(props.message);
	const entryId = entryIds.get(props.message.id);
	const canEdit = Boolean(branch && entryId && text.trim() && !branch.busy);
	if (branch && entryId && branch.editingId === entryId) {
		return (
			<InlineEdit
				text={text}
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
	return (
		<CopilotChatInput.TextArea
			{...props}
			ref={ref}
			onPaste={(event) => {
				const files = [...event.clipboardData.files];
				if (files.length === 0) return;
				event.preventDefault();
				actions?.addFiles(files);
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && actions?.hasImages && !(props.value ?? "").toString().trim()) {
					event.preventDefault();
					actions.sendImageOnly();
					return;
				}
				props.onKeyDown?.(event);
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
	const { agent } = useAgent();
	const [queued, setQueued] = useState<QueuedFollowUp[]>([]);
	const [images, setImages] = useState<PendingImage[]>([]);
	const [imageError, setImageError] = useState<string | null>(null);
	const imagesRef = useRef(images);
	imagesRef.current = images;
	const valueRef = useRef(value);
	valueRef.current = value;
	const fileRef = useRef<HTMLInputElement>(null);
	const hasDraft = (value ?? "").trim().length > 0 || images.length > 0;
	const appliedDraft = useRef<string | null>(null);
	const emptySeen = useRef(false);
	const forceSeen = useRef<ForceView | null>(null);
	branch?.bindDeliver((installed, text) => {
		agent.setMessages(installed);
		onSubmitMessage?.(text);
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

	const deliverRef = useRef<(submitted: string) => void>(() => {});
	deliverRef.current = (submitted) => {
		void (async () => {
			const text = submitted.replaceAll("\u200b", "").trim() ? submitted.replaceAll("\u200b", "") : "";
			const payload = imagesRef.current;
			if (!text && payload.length === 0) return;
			if (payload.length > 0) {
				if (!threadId || typeof window.loom.stageComposerImages !== "function") {
					setImageError(threadId ? "Restart the app to send images." : "Open a session before attaching an image.");
					return;
				}
				try {
					await window.loom.stageComposerImages(threadId, payload.map(({ filename, mimeType, data }) => ({ filename, mimeType, data })));
				} catch (cause) {
					setImageError(cause instanceof Error ? cause.message : "Could not attach that image.");
					if (text) onChange?.(text);
					return;
				}
			}
			setImages([]);
			setImageError(null);
			if (!isRunning || !threadId) {
				onSubmitMessage?.(text || "\u200b");
				onChange?.("");
				return;
			}
			const seen = visible.filter((message) => message.role === "user" && messageText(message) === text).length;
			try {
				await window.loom.followUp(threadId, text);
				setQueued((items) => [...items, {
					text,
					label: text || payload.map((image) => image.filename).join(", "),
					seen,
				}]);
				onChange?.("");
			} catch {
				setImages(payload);
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

	const composerActions: ComposerActions = {
		addFiles: (files) => { void addFiles(files); },
		sendImageOnly: () => deliverRef.current((valueRef.current ?? "").trim() || "\u200b"),
		hasImages: images.length > 0,
	};

	return (
		<ComposerActionsContext.Provider value={composerActions}>
		<div
			className="session-follow-up-slot"
			onDragOver={(event) => {
				if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
			}}
			onDrop={(event) => {
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
			<CopilotChatInput
				{...props}
				value={value}
				isRunning={Boolean(isRunning) && !hasDraft}
				showDisclaimer={false}
				onChange={onChange}
				onAddFile={() => fileRef.current?.click()}
				addMenuButton={AddFilesButton}
				textArea={ComposerTextArea}
				sendButton={images.length > 0 ? ImageSendButton : undefined}
				onSubmitMessage={(submitted) => {
					deliverRef.current(submitted);
				}}
			/>
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
	onSessionRecord,
	onForked,
}: {
	threadId: string;
	messages: LoomTranscriptMessage[];
	context: HarnessContextUsage | null;
	composerDraft: string | null;
	onComposerDraftApplied: () => void;
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
		<StoredMessagesContext.Provider value={stored}>
			<ThreadIdContext.Provider value={threadId}>
			<BranchContext.Provider value={actions}>
			<ForceContext.Provider value={force}>
			<ClearForceContext.Provider value={clearForce}>
			<DraftContext.Provider value={composerDraft}>
			<DraftAppliedContext.Provider value={onComposerDraftApplied}>
			<div className="session-chat-shell">
				<CopilotChat key={threadId} threadId={threadId} chatView={SessionChatView} labels={{ chatInputToolbarAddButtonLabel: "Add files" }} />
				<ContextIndicator context={context} />
			</div>
			</DraftAppliedContext.Provider>
			</DraftContext.Provider>
			</ClearForceContext.Provider>
			</ForceContext.Provider>
			</BranchContext.Provider>
			</ThreadIdContext.Provider>
		</StoredMessagesContext.Provider>
	);
}

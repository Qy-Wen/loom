import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@ag-ui/core";
import { ChatError, ComposerForm } from "@loom/ag-ui-react";
import type { LoomUserAttachment } from "@loom/agent";
import { contentWithPlacedAssets, referenceKey } from "@loom/agent/attachments";
import { failureShownInHistory, formatChatError } from "../../shared/chat-error.ts";
import type { ChatModelView } from "../../shared/chat-models.ts";
import type { SessionCompactionResult } from "../../shared/ipc.ts";
import { assetRefBlocks, composerLayoutText, displayAssetRefs, inlineReferenceKeys, parseComposerAssetInputs, storedAssetRefs, stripInlineAssetRefs } from "@loom/agent/composer-asset";
import { endLibraryDrag, hasLibraryDrag, readComposerDrag } from "../assets/asset-drag.ts";
import { useLocale } from "../locale.tsx";
import { AgentPermissionSelect } from "./agent-permission.tsx";
import { useLibraryAssets, useLibraryFolders, useOpenReference } from "./asset-open.tsx";
import { ChatViewContext, ComposerActionsContext, useChatSession, type ComposerActions, type PendingEdit } from "./chat-context.ts";
import { editableText, placedChips } from "./chat-content.ts";
import { AddFilesButton, ComposerTextArea } from "./chat-composer-input.tsx";
import { composerFileInputs } from "./composer-files.ts";
import { ContextIndicator } from "./chat-context-usage.tsx";
import { SessionModelSelect } from "./chat-model-select.tsx";
import { hasImageAsset, modelLacksImageInput } from "./image-support.ts";
import { appendChip, focusInlineEditor, insertChipAtPoint, lookupComposerAsset, paintInlineEditor, readInlineEditor, rememberComposerAsset, type ChipLabels } from "./inline-asset-text.tsx";

/** `ready` once the main process has admitted it, i.e. it can be withdrawn. */
type QueuedFollowUp = { id: string; label: string; ready: boolean };

function reconcileQueued(items: QueuedFollowUp[], messages: readonly Message[]): QueuedFollowUp[] {
	const admitted = new Set(messages.map((message) => message.metadata?.["loom.clientMessageId"]));
	const next = items.filter((item) => !admitted.has(item.id));
	return next.length === items.length ? items : next;
}

/** Enter while a run is active queues a follow-up. Empty input keeps Stop; text or an asset restores Send. */
export function FollowUpInput({ onSubmitMessage, isRunning, onStop }: {
	onSubmitMessage: (text: string) => Promise<unknown>;
	isRunning: boolean;
	onStop: () => void;
}) {
	const [value, onChange] = useState("");
	const { t } = useLocale();
	const chipLabels = useRef<ChipLabels>({ remove: t.common.remove, removeNamed: t.chat.removeNamed });
	chipLabels.current = { remove: t.common.remove, removeNamed: t.chat.removeNamed };
	const { threadId, branch, runError, pendingEdit, editSubmitted, composerAttach, onComposerAttachApplied, draftRequest, draftApplied, stored, transcript, usage, model, onModelChanged } = useChatSession();
	const { messages: visible, connecting, threadReady } = useContext(ChatViewContext);
	const [queued, setQueued] = useState<QueuedFollowUp[]>([]);
	const [assets, setAssets] = useState<LoomUserAttachment[]>([]);
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const [compactionFeedback, setCompactionFeedback] = useState<{ result: SessionCompactionResult } | { error: string } | null>(null);
	const pendingCompactions = useRef(new Set<string>());
	const [compactionEpoch, setCompactionEpoch] = useState(0);
	const [catalog, setCatalog] = useState<ChatModelView[] | null>(null);
	const assetsRef = useRef(assets);
	assetsRef.current = assets;
	const editorRef = useRef<HTMLDivElement | null>(null);
	const openReference = useOpenReference();
	const libraryAssets = useLibraryAssets();
	const libraryFolders = useLibraryFolders();
	useEffect(() => {
		let cancelled = false;
		const load = () => {
			void window.loom.getChatSettings().then((view) => { if (!cancelled) setCatalog(view.models); }).catch(() => {});
		};
		load();
		const stop = window.loom.onChatSettingsChanged(load);
		return () => { cancelled = true; stop(); };
	}, []);
	const textOnlyModel = modelLacksImageInput(model, catalog);
	const hasDraft = editableText(value) || assets.length > 0;
	const bareSlash = value.trim() === "/" && assets.length === 0;
	const compacting = useMemo(() => pendingCompactions.current.has(threadId), [compactionEpoch, threadId]);
	useEffect(() => {
		setAssets([]);
		setQueued([]);
		setAttachmentError(null);
		setCompactionFeedback(null);
		onChange("");
	}, [threadId]);
	const submittedEdit = useRef<PendingEdit | null>(null);
	useEffect(() => {
		// A controlled thread switch connects asynchronously. Never send through the old thread's callback.
		if (!pendingEdit || pendingEdit.threadId !== threadId || !threadReady || connecting || isRunning || compacting || submittedEdit.current === pendingEdit) return;
		submittedEdit.current = pendingEdit;
		editSubmitted(pendingEdit);
		void (async () => {
			const text = pendingEdit.text;
			const chips = placedChips([
				...assetRefBlocks(text),
				...inlineReferenceKeys(text).flatMap((id) => {
					const known = lookupComposerAsset(id);
					return known && known.type !== "ui_selection" ? [known] : [];
				}),
			]);
			try {
				await window.loom.stageComposerAssets(threadId, chips);
				await onSubmitMessage(contentWithPlacedAssets(text, chips));
			} catch (cause) {
				setAttachmentError(cause instanceof Error ? cause.message : t.chat.attachFailed);
				onChange(text);
			}
		})();
	}, [pendingEdit, editSubmitted, threadId, threadReady, connecting, isRunning, compacting, onSubmitMessage, onChange, t.chat.attachFailed]);

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
			setAttachmentError(null);
			const key = referenceKey(composerAttach);
			try {
				rememberComposerAsset(composerAttach);
				setAssets((current) => current.some((item) => referenceKey(item) === key) ? current : [...current, composerAttach]);
				const chip = appendChip(editor, composerAttach, openReference, chipLabels.current);
				onChange(composerLayoutText(readInlineEditor(editor)));
				const activate = () => {
					const current = editorRef.current;
					if (!current?.isConnected) return;
					const node = chip && current.contains(chip)
						? chip
						: current.querySelector(`[data-reference-key="${CSS.escape(key)}"]`);
					focusInlineEditor(current, node);
				};
				requestAnimationFrame(() => {
					activate();
					window.setTimeout(activate, 0);
					window.setTimeout(activate, 50);
				});
			} catch (cause) {
				setAttachmentError(cause instanceof Error ? cause.message : t.chat.attachFailed);
			}
			onComposerAttachApplied();
		};
		run();
		return () => {
			cancelled = true;
		};
	}, [composerAttach]);

	useLayoutEffect(() => {
		// A suggestion replaces an empty draft only. Typed text or attached files are never overwritten.
		if (!draftRequest || draftRequest.threadId !== threadId) return;
		const editor = editorRef.current;
		if (!editor) return;
		if (!readInlineEditor(editor) && assetsRef.current.length === 0) {
			paintInlineEditor(editor, draftRequest.text, [], (assetId) => openReference(assetId), chipLabels.current);
			onChange(draftRequest.text);
		}
		draftApplied(draftRequest);
		requestAnimationFrame(() => {
			const current = editorRef.current;
			if (current?.isConnected) focusInlineEditor(current, current.lastChild);
		});
	}, [draftRequest]);

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

	const removeQueued = (clientMessageId: string) => {
		void window.loom.cancelFollowUp(threadId, clientMessageId).then((removed) => {
			// Too late means it was already placed; transcript reconciliation drops the row.
			if (removed && activeThread.current === threadId) setQueued((items) => items.filter((item) => item.id !== clientMessageId));
		}).catch(() => {});
	};

	const submitting = useRef(false);
	const activeThread = useRef(threadId);
	activeThread.current = threadId;
	const running = useRef(isRunning);
	running.current = isRunning;
	const deliver = (shortcut?: "/compact") => {
		if (submitting.current || pendingCompactions.current.has(threadId)) return;
		const raw = (editorRef.current ? readInlineEditor(editorRef.current) : value).replaceAll("\u200b", "");
		const text = editableText(raw) ? raw : "";
		// Chips can reach the DOM before React commits the attachment state.
		const assetPayload = editorRef.current ? displayAssetRefs(raw, assetsRef.current) : assetsRef.current;
		if (!text && assetPayload.length === 0) return;
		if (!threadReady) {
			onChange(raw);
			return;
		}
		const command = assetPayload.length === 0 ? raw.trim() : "";
		if (shortcut && (!command.startsWith("/") || !shortcut.startsWith(raw.trimStart()))) return;
		if ((shortcut ?? command) === "/compact") {
			pendingCompactions.current.add(threadId);
			setCompactionEpoch((epoch) => epoch + 1);
			if (shortcut) editorRef.current?.focus();
			setAttachmentError(null);
			setCompactionFeedback(null);
			onChange("");
			void (async () => {
				try {
					const result = await window.loom.compactSession(threadId);
					if (activeThread.current === threadId) setCompactionFeedback({ result });
				} catch (cause) {
					if (activeThread.current === threadId) setCompactionFeedback({ error: formatChatError(cause) });
				} finally {
					pendingCompactions.current.delete(threadId);
					setCompactionEpoch((epoch) => epoch + 1);
				}
			})();
			return;
		}
		if (command === "/") return;
		setCompactionFeedback(null);
		submitting.current = true;
		void (async () => {
			let queuedId: string | null = null;
			try {
				await window.loom.stageComposerAssets(threadId, placedChips(assetPayload));
				if (activeThread.current !== threadId) return;
				setAssets([]);
				setAttachmentError(null);
				const body = contentWithPlacedAssets(text, placedChips(assetPayload));
				if (!running.current) {
					onChange("");
					void onSubmitMessage(body || "\u200b").catch((cause: unknown) => {
						if (activeThread.current === threadId) setAttachmentError(cause instanceof Error ? cause.message : t.chat.attachFailed);
					});
					return;
				}
				queuedId = crypto.randomUUID();
				const visibleText = stripInlineAssetRefs(body).trim();
				const label = visibleText || assetPayload.map((asset) => asset.path.split("/").pop() || asset.path).join(", ");
				const queued = { id: queuedId, label, ready: false };
				setQueued((items) => [...items, queued]);
				await window.loom.followUp(threadId, body, queuedId);
				setQueued((items) => items.map((item) => item.id === queued.id ? { ...item, ready: true } : item));
				if (activeThread.current === threadId) onChange("");
			} catch (cause) {
				if (activeThread.current !== threadId) return;
				if (queuedId) setQueued((items) => items.filter((item) => item.id !== queuedId));
				setAssets(assetPayload);
				setAttachmentError(cause instanceof Error ? cause.message : t.chat.attachFailed);
				onChange(raw);
			} finally {
				submitting.current = false;
			}
		})();
	};

	async function importDroppedFiles(files: File[]): Promise<void> {
		if (typeof window.loom.importComposerFiles !== "function" || typeof window.loom.pathForFile !== "function") {
			setAttachmentError(t.chat.restartToAttach);
			return;
		}
		const importThread = threadId;
		try {
			const { paths, images } = await composerFileInputs(files, (file) => window.loom.pathForFile(file));
			const picked = await window.loom.importComposerFiles(paths, images);
			if (activeThread.current !== importThread) return;
			if (picked.length === 0) return;
			appendAssets(picked.map((asset) => ({
				type: "asset_ref",
				assetId: asset.assetId,
				path: asset.path,
				assetType: asset.assetType,
			})));
		} catch (cause) {
			if (activeThread.current !== importThread) return;
			setAttachmentError(cause instanceof Error ? cause.message : t.chat.attachFailed);
		}
	}

	function appendAssets(items: LoomUserAttachment[]): void {
		const parsed = parseComposerAssetInputs(items);
		if (parsed.length === 0) return;
		setAttachmentError(null);
		const editor = editorRef.current;
		for (const asset of parsed) {
			rememberComposerAsset(asset);
			if (editor) appendChip(editor, asset, openReference, chipLabels.current);
		}
		setAssets((current) => {
			const next = [...current];
			for (const asset of parsed) {
				if (!next.some((item) => referenceKey(item) === referenceKey(asset))) next.push(asset);
			}
			return next;
		});
		if (editor) onChange(composerLayoutText(readInlineEditor(editor)));
		const last = parsed.at(-1);
		const activate = () => {
			const current = editorRef.current;
			if (!current?.isConnected || !last) return;
			const node = current.querySelector(`[data-reference-key="${CSS.escape(referenceKey(last))}"]`);
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
			setAttachmentError(t.chat.restartToAttachLibrary);
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
			setAttachmentError(cause instanceof Error ? cause.message : t.chat.attachFailed);
		}
	}

	async function pickExternalFiles(): Promise<void> {
		if (typeof window.loom.pickComposerExternalFiles !== "function") {
			setAttachmentError(t.chat.restartToAttach);
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
			setAttachmentError(cause instanceof Error ? cause.message : t.chat.attachFailed);
		}
	}

	function placeAsset(value: unknown, x: number, y: number): void {
		setAttachmentError(null);
		try {
			const asset = parseComposerAssetInputs([value])[0];
			if (!asset) return;
			rememberComposerAsset(asset);
			setAssets((current) => current.some((item) => referenceKey(item) === referenceKey(asset)) ? current : [...current, asset]);
			const editor = editorRef.current;
			const placed = editor ? insertChipAtPoint(editor, asset, x, y, openReference, chipLabels.current) : false;
			if (placed && editor) onChange(composerLayoutText(readInlineEditor(editor)));
			else if (editor) {
				appendChip(editor, asset, openReference, chipLabels.current);
				onChange(composerLayoutText(readInlineEditor(editor)));
			}
		} catch (cause) {
			setAttachmentError(cause instanceof Error ? cause.message : t.chat.attachFailed);
		}
	}

	const composerActions: ComposerActions = {
		importFiles: (files) => { void importDroppedFiles(files); },
		pickLibrary: () => { void pickLibraryFiles(); },
		pickExternal: () => { void pickExternalFiles(); },
		assets,
		bindEditor: (editor) => {
			editorRef.current = editor;
		},
		openReference,
		syncAssets: () => {
			const editor = editorRef.current;
			if (!editor) {
				setAssets([]);
				return;
			}
			const next: LoomUserAttachment[] = [];
			const seen = new Set<string>();
			for (const node of editor.querySelectorAll<HTMLElement>("[data-reference-key]")) {
				const id = node.dataset.referenceKey;
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
				if (hasLibraryDrag(event.dataTransfer)) {
					event.preventDefault();
					try {
						const dropped = readComposerDrag(event.dataTransfer, libraryAssets, libraryFolders);
						endLibraryDrag();
						for (const reference of dropped) placeAsset(reference, event.clientX, event.clientY);
					} catch {
						setAttachmentError(t.chat.attachFailed);
					}
					return;
				}
				const files = [...event.dataTransfer.files];
				if (files.length === 0) return;
				event.preventDefault();
				void importDroppedFiles(files);
			}}
		>
			{runError !== null && !failureShownInHistory(stored, runError) && (
				<ChatError
					label={t.chat.requestFailed}
					message={runError.trim() === "no_model" ? t.chat.modelRequired : formatChatError(runError)}
				/>
			)}
			{branch?.error && !branch.editingId && <div className="session-branch-note session-branch-error">{branch.error}</div>}
			{attachmentError && <div className="session-branch-note session-branch-error">{attachmentError}</div>}
			{compacting
				? <div className="session-branch-note" role="status">{t.chat.compaction.pending}</div>
				: compactionFeedback && ("error" in compactionFeedback
					? <ChatError label={t.chat.compaction.failed} message={compactionFeedback.error} />
					: <div className="session-branch-note" role="status">{t.chat.compaction[compactionFeedback.result]}</div>)}
			{textOnlyModel && hasImageAsset(assets) && <div className="session-branch-note" role="status">{t.chat.modelNoImages}</div>}
			{queued.length > 0 && (
				<section className="session-follow-up" aria-label={t.chat.queued}>
					<div className="session-follow-up-label">{t.chat.queued}</div>
					<ol>
						{queued.map((item) => (
							<li key={item.id}>
								<span>{item.label}</span>
								<button type="button" className="session-follow-up-remove" aria-label={t.chat.removeQueued} data-tooltip={t.chat.removeQueued} disabled={!item.ready} onClick={() => removeQueued(item.id)}>×</button>
							</li>
						))}
					</ol>
				</section>
			)}
			<ComposerForm
				editor={<ComposerTextArea
					value={value}
					onChange={onChange}
					compactAvailable={assets.length === 0}
					compactDisabled={!threadReady || compacting}
					onCompact={() => deliver("/compact")}
				/>}
				leading={<AddFilesButton />}
				controls={<div className="session-composer-meta">
					<AgentPermissionSelect />
					<SessionModelSelect sessionId={threadId} model={model} onChange={onModelChanged} disabled={isRunning} />
					<ContextIndicator context={usage} />
				</div>}
				onSubmit={() => deliver()}
				submitDisabled={!hasDraft || !threadReady || bareSlash || compacting}
				onStop={isRunning && (!hasDraft || bareSlash) ? onStop : undefined}
				labels={{ send: t.chat.send, stop: t.chat.stop }}
			/>
		</div>
		</ComposerActionsContext.Provider>
	);
}

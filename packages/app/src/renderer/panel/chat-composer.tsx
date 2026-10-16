import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Message } from "@ag-ui/core";
import { CopilotChatInput, type CopilotChatInputProps } from "@copilotkit/react-core/v2";
import type { LoomUserAttachment } from "@loom/agent";
import { contentWithPlacedAssets } from "@loom/agent/attachments";
import { assetRefBlocks, composerLayoutText, inlineAssetIds, parseComposerAssetInputs, storedAssetRefs, stripInlineAssetRefs } from "@loom/agent/composer-asset";
import { LOOM_ASSET_DRAG, readAssetDrag } from "../assets/asset-drag.ts";
import { useLocale } from "../locale.tsx";
import { AgentPermissionSelect } from "./agent-permission.tsx";
import { useOpenAsset } from "./asset-open.tsx";
import { ChatViewContext, ComposerActionsContext, useChatSession, type ComposerActions, type PendingEdit } from "./chat-context.ts";
import { editableText, placedChips } from "./chat-content.ts";
import { AddFilesButton, ComposerTextArea, ImageSendButton } from "./chat-composer-input.tsx";
import { ContextIndicator } from "./chat-context-usage.tsx";
import { appendChip, focusInlineEditor, insertChipAtPoint, lookupComposerAsset, readInlineEditor, rememberComposerAsset, type ChipLabels } from "./inline-asset-text.tsx";

type QueuedFollowUp = { id: string; label: string };

function reconcileQueued(items: QueuedFollowUp[], messages: readonly Message[]): QueuedFollowUp[] {
	const admitted = new Set(messages.map((message) => message.metadata?.["loom.clientMessageId"]));
	const next = items.filter((item) => !admitted.has(item.id));
	return next.length === items.length ? items : next;
}

/** Enter while a run is active queues a follow-up. Empty input keeps Stop; text or an image restores Send. */
export const FollowUpInput = (({ onSubmitMessage, isRunning, onChange, value, ...props }: CopilotChatInputProps) => {
	const { t } = useLocale();
	const chipLabels = useRef<ChipLabels>({ remove: t.common.remove, removeNamed: t.chat.removeNamed });
	chipLabels.current = { remove: t.common.remove, removeNamed: t.chat.removeNamed };
	const { threadId, branch, pendingEdit, editSubmitted, draft, onDraftApplied, composerAttach, onComposerAttachApplied, transcript, usage } = useChatSession();
	const { messages: visible, connecting, threadReady } = useContext(ChatViewContext);
	const [queued, setQueued] = useState<QueuedFollowUp[]>([]);
	const [assets, setAssets] = useState<LoomUserAttachment[]>([]);
	const [imageError, setImageError] = useState<string | null>(null);
	const assetsRef = useRef(assets);
	assetsRef.current = assets;
	const valueRef = useRef(value);
	valueRef.current = value;
	const editorRef = useRef<HTMLDivElement | null>(null);
	const openAsset = useOpenAsset();
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
	const submittedEdit = useRef<PendingEdit | null>(null);
	useEffect(() => {
		// A controlled thread switch connects asynchronously. Never send through the old thread's callback.
		if (!pendingEdit || pendingEdit.threadId !== threadId || !threadReady || connecting || isRunning || !onSubmitMessage || submittedEdit.current === pendingEdit) return;
		submittedEdit.current = pendingEdit;
		editSubmitted(pendingEdit);
		void (async () => {
			const text = pendingEdit.text;
			const chips = placedChips([
				...assetRefBlocks(text),
				...inlineAssetIds(text).flatMap((id) => {
					const known = lookupComposerAsset(id);
					return known && known.type === "asset_ref" ? [known] : [];
				}),
			]);
			try {
				if (chips.length > 0) await window.loom.stageComposerAssets(threadId, chips.map(({ assetId, path, assetType }) => ({ assetId, path, assetType })));
				await onSubmitMessage(contentWithPlacedAssets(text, chips));
			} catch (cause) {
				setImageError(cause instanceof Error ? cause.message : t.chat.attachFailed);
				onChange?.(text);
			}
		})();
	}, [pendingEdit, editSubmitted, threadId, threadReady, connecting, isRunning, onSubmitMessage, onChange, t.chat.attachFailed]);

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

	const submitting = useRef(false);
	const activeThread = useRef(threadId);
	activeThread.current = threadId;
	const deliverRef = useRef<(submitted: string) => void>(() => {});
	deliverRef.current = (submitted) => {
		if (submitting.current) return;
		const raw = (editorRef.current ? readInlineEditor(editorRef.current) : submitted).replaceAll("\u200b", "");
		const text = editableText(raw) ? raw : "";
		const assetPayload = assetsRef.current;
		if (!text && assetPayload.length === 0) return;
		if (!onSubmitMessage || !threadReady) {
			onChange?.(raw);
			return;
		}
		submitting.current = true;
		void (async () => {
			let queuedId: string | null = null;
			try {
				if (assetPayload.length > 0) await window.loom.stageComposerAssets(threadId, assetPayload.map(({ assetId, path, assetType }) => ({ assetId, path, assetType })));
				if (activeThread.current !== threadId) return;
				setAssets([]);
				setImageError(null);
				const body = contentWithPlacedAssets(text, placedChips(assetPayload));
				if (!isRunning) {
					void onSubmitMessage(body || "\u200b");
					onChange?.("");
					return;
				}
				queuedId = crypto.randomUUID();
				const visibleText = stripInlineAssetRefs(body).trim();
				const label = visibleText || assetPayload.map((asset) => asset.path.split("/").pop() || asset.path).join(", ");
				const queued = { id: queuedId, label };
				setQueued((items) => [...items, queued]);
				await window.loom.followUp(threadId, body, queuedId);
				if (activeThread.current === threadId) onChange?.("");
			} catch (cause) {
				if (activeThread.current !== threadId) return;
				if (queuedId) setQueued((items) => items.filter((item) => item.id !== queuedId));
				setAssets(assetPayload);
				setImageError(cause instanceof Error ? cause.message : t.chat.attachFailed);
				onChange?.(raw);
			} finally {
				submitting.current = false;
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
						{queued.map((item) => (
							<li key={item.id}>{item.label}</li>
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
					onSubmitMessage={threadReady && onSubmitMessage ? (submitted) => {
						deliverRef.current(submitted);
					} : undefined}
				/>
			</div>
		</div>
		</ComposerActionsContext.Provider>
	);
}) as typeof CopilotChatInput;

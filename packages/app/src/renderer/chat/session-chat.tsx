import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEndpoint } from "../../shared/ipc.ts";
import type { AssetRefAttachment, LoomContextUsage, LoomSessionModel, LoomSessionRecord, LoomTranscriptMessage } from "@loom/agent";
import { mergeChatMessages, toAgUiMessages } from "../../shared/ag-ui-messages.ts";
import { useLocale } from "../locale.tsx";
import { ChatSessionContext, ChatViewContext, useChatSession, type BranchActions, type DraftRequest, type PendingEdit } from "./chat-context.ts";
import { SessionTranscript } from "./session-transcript.tsx";
import { FollowUpInput } from "./chat-composer.tsx";
import { useChatStream } from "./use-chat-stream.ts";
import { useConfirmation } from "../components/confirm-dialog.tsx";

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function SessionChat({
	endpoint,
	libraryRoot,
	threadId,
	messages,
	context,
	model,
	composerAttach,
	onComposerAttachApplied,
	onSessionRecord,
	onHistoryChanged,
	onForked,
	onOpenSettings,
}: {
	endpoint: AgentEndpoint;
	libraryRoot: string;
	threadId: string;
	messages: LoomTranscriptMessage[];
	context: LoomContextUsage | null;
	model: LoomSessionModel | undefined;
	composerAttach: AssetRefAttachment | null;
	onComposerAttachApplied: () => void;
	onSessionRecord: (record: LoomSessionRecord) => void;
	onHistoryChanged: () => void;
	onForked: (record: LoomSessionRecord) => void;
	onOpenSettings: () => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const { confirm } = useConfirmation(threadId);
	const stored = useMemo(() => toAgUiMessages(messages), [messages]);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
	const [draftRequest, setDraftRequest] = useState<DraftRequest | null>(null);
	const editingRef = useRef<string | null>(null);
	const activeThread = useRef(threadId);
	activeThread.current = threadId;
	const draftApplied = useCallback((request: DraftRequest) => setDraftRequest((current) => current === request ? null : current), []);
	const editSubmitted = useCallback((edit: PendingEdit) => setPendingEdit((current) => current === edit ? null : current), []);
	const onRecord = useRef(onSessionRecord);
	const onFork = useRef(onForked);
	onRecord.current = onSessionRecord;
	onFork.current = onForked;
	const stream = useChatStream(endpoint, threadId, onHistoryChanged);
	const visible = useMemo(() => mergeChatMessages(stored, stream.messages), [stored, stream.messages]);

	useEffect(() => {
		editingRef.current = null;
		setEditingId(null);
		setError(null);
		setBusy(false);
		setDraftRequest(null);
	}, [threadId]);

	const actions = useMemo<BranchActions>(() => ({
		busy,
		editingId,
		error,
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
		async fork(entryId) {
			if (!await confirm({
				title: t.chat.forkTitle,
				description: t.chat.forkConfirm,
				confirmLabel: t.chat.forkAction,
			}) || activeThread.current !== threadId) return;
			setBusy(true);
			setError(null);
			try {
				const record = await window.loom.forkAfter(threadId, entryId);
				if (activeThread.current !== threadId) return;
				onFork.current(record);
			} catch (cause) {
				setError(errorText(cause));
			} finally {
				setBusy(false);
			}
		},
		async commitEdit(text, model) {
			const entryId = editingRef.current;
			if (!entryId) return;
			setBusy(true);
			setError(null);
			try {
				const record = await window.loom.branchBefore(threadId, entryId, model);
				if (activeThread.current !== threadId) return;
				editingRef.current = null;
				setEditingId(null);
				setPendingEdit({ threadId: record.id, text });
				onRecord.current(record);
			} catch (cause) {
				setError(errorText(cause));
			} finally {
				setBusy(false);
			}
		},
	}), [busy, editingId, error, threadId, confirm, t.chat.forkTitle, t.chat.forkConfirm, t.chat.forkAction]);

	return (
		<ChatSessionContext.Provider value={{ threadId, stored, transcript: messages, branch: actions, runError: stream.error, pendingEdit, editSubmitted, composerAttach, onComposerAttachApplied, requestDraft: setDraftRequest, draftRequest, draftApplied, onOpenSettings, usage: context, model, onModelChanged: () => { void onHistoryChanged(); } }}>
			<ChatViewContext.Provider value={{ messages: visible, connecting: stream.connecting, threadReady: !stream.connecting }}>
				<div className="session-chat-shell">
					<SessionTranscript messages={visible} isRunning={stream.isRunning} libraryRoot={libraryRoot} />
					<FollowUpInput onSubmitMessage={stream.send} isRunning={stream.isRunning} onStop={stream.stop} />
				</div>
			</ChatViewContext.Provider>
		</ChatSessionContext.Provider>
	);
}

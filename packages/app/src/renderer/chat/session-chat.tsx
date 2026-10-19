import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@ag-ui/core";
import { CopilotChat, useAgent, type CopilotChatViewProps } from "@copilotkit/react-core/v2";
import type { AssetRefAttachment, LoomContextUsage, LoomSessionModel, LoomSessionRecord, LoomTranscriptMessage } from "@loom/agent";
import { liveMessagesForSession, mergeChatMessages, toAgUiMessages } from "../../shared/ag-ui-messages.ts";
import { useLocale } from "../locale.tsx";
import { ChatSessionContext, ChatViewContext, useChatSession, type BranchActions, type PendingEdit } from "./chat-context.ts";
import { SessionScrollView } from "./chat-scroll.tsx";
import { SessionMessageView } from "./chat-messages.tsx";
import { FollowUpInput } from "./chat-composer.tsx";
import { useChatStream } from "./use-chat-stream.ts";

/** Stable slot so CopilotChat does not remount the view on every parent render. */
function SessionChatView(props: CopilotChatViewProps): React.JSX.Element {
	const { stored, threadId } = useChatSession();
	const { agent } = useAgent({ updates: [] });
	const seenThread = useRef<string | null>(null);
	const skippedLive = useRef<readonly Message[] | null>(null);
	const rawLive = props.messages ?? [];
	// A newly mounted view may reuse an agent from another thread or library.
	if (seenThread.current !== threadId) {
		skippedLive.current = rawLive;
		seenThread.current = threadId;
	}
	const live = liveMessagesForSession(threadId, agent.threadId, rawLive, skippedLive.current);
	const messages = useMemo(
		() => mergeChatMessages(stored, live),
		[stored, live],
	);
	return (
		<ChatViewContext.Provider value={{ messages, connecting: Boolean(props.isConnecting), threadReady: agent.threadId === threadId }}>
			<CopilotChat.View
				{...props}
				messages={messages}
				scrollView={SessionScrollView}
				messageView={SessionMessageView}
				input={FollowUpInput}
			/>
		</ChatViewContext.Provider>
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
	model,
	composerDraft,
	onComposerDraftApplied,
	composerAttach,
	onComposerAttachApplied,
	onSessionRecord,
	onHistoryChanged,
	onForked,
}: {
	threadId: string;
	messages: LoomTranscriptMessage[];
	context: LoomContextUsage | null;
	model: LoomSessionModel | undefined;
	composerDraft: string | null;
	onComposerDraftApplied: () => void;
	composerAttach: AssetRefAttachment | null;
	onComposerAttachApplied: () => void;
	onSessionRecord: (record: LoomSessionRecord) => void;
	onHistoryChanged: () => void;
	onForked: (record: LoomSessionRecord, draft: string) => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const stored = useMemo(() => toAgUiMessages(messages), [messages]);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
	const editingRef = useRef<string | null>(null);
	const activeThread = useRef(threadId);
	activeThread.current = threadId;
	const editSubmitted = useCallback((edit: PendingEdit) => setPendingEdit((current) => current === edit ? null : current), []);
	const onRecord = useRef(onSessionRecord);
	const onFork = useRef(onForked);
	onRecord.current = onSessionRecord;
	onFork.current = onForked;
	const runError = useChatStream(threadId, onHistoryChanged);

	useEffect(() => {
		editingRef.current = null;
		setEditingId(null);
		setError(null);
		setBusy(false);
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
		async fork(entryId, text) {
			setBusy(true);
			setError(null);
			try {
				const record = await window.loom.forkBefore(threadId, entryId);
				if (activeThread.current !== threadId) return;
				onFork.current(record, text);
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
	}), [busy, editingId, error, threadId]);

	return (
		<ChatSessionContext.Provider value={{ threadId, stored, transcript: messages, branch: actions, runError, pendingEdit, editSubmitted, draft: composerDraft, onDraftApplied: onComposerDraftApplied, composerAttach, onComposerAttachApplied, usage: context, model, onModelChanged: () => { void onHistoryChanged(); } }}>
			<div className="session-chat-shell">
				<CopilotChat threadId={threadId} welcomeScreen={false} chatView={SessionChatView} labels={{ chatInputToolbarAddButtonLabel: t.chat.add }} />
			</div>
		</ChatSessionContext.Provider>
	);
}

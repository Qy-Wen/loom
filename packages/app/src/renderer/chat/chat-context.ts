import { createContext, useContext } from "react";
import type { Message } from "@ag-ui/core";
import type { AssetRefAttachment, LoomContextUsage, LoomSessionModel, LoomTranscriptMessage, LoomUserAttachment } from "@loom/agent";

export type PendingEdit = { threadId: string; text: string };
export type BranchActions = {
	busy: boolean;
	editingId: string | null;
	error: string | null;
	edit: (entryId: string) => void;
	cancelEdit: () => void;
	fork: (entryId: string, text: string) => void;
	commitEdit: (text: string) => Promise<void>;
};

export type ChatSession = {
	threadId: string;
	stored: Message[];
	transcript: readonly LoomTranscriptMessage[];
	branch: BranchActions;
	runError: string | null;
	pendingEdit: PendingEdit | null;
	editSubmitted: (edit: PendingEdit) => void;
	draft: string | null;
	onDraftApplied: () => void;
	composerAttach: AssetRefAttachment | null;
	onComposerAttachApplied: () => void;
	usage: LoomContextUsage | null;
	model: LoomSessionModel | undefined;
	/** Refresh the session record after a per-conversation model change. */
	onModelChanged: () => void;
};

export const ChatSessionContext = createContext<ChatSession | null>(null);
export const ChatViewContext = createContext<{ messages: Message[]; connecting: boolean; threadReady: boolean }>({ messages: [], connecting: true, threadReady: false });

export function useChatSession(): ChatSession {
	const session = useContext(ChatSessionContext);
	if (!session) throw new Error("ChatSessionContext is missing");
	return session;
}

export type ComposerActions = {
	importFiles: (files: File[]) => void;
	pickLibrary: () => void;
	pickExternal: () => void;
	sendAssets: () => void;
	hasAssets: boolean;
	assets: readonly LoomUserAttachment[];
	bindEditor: (editor: HTMLDivElement | null) => void;
	openAsset: (assetId: string) => void;
	syncAssets: () => void;
};
export const ComposerActionsContext = createContext<ComposerActions | null>(null);

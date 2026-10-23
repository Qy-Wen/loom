import type { Context } from "@earendil-works/chord";
import {
	defineDoc,
	type ConversationId,
	type ConversationRecord,
	type Cursor,
	type Harness,
	type Tx,
} from "../durable-adapter.ts";
import { DEFAULT_SESSION_TITLE } from "./session-title.ts";

export const FORK_TITLE_SUFFIX = "（分支）";
export type LoomConversationMetadata = { title: string; archived: boolean; hidden: boolean; createdAt: number };

/** Latest metadata, outside the transcript. Forks copy the title; creation resets archive and adds a suffix. */
export const LoomConversationDoc = defineDoc<LoomConversationMetadata>({
	kind: "loom.conversation",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ title: DEFAULT_SESSION_TITLE, archived: false, hidden: false, createdAt: 0 }),
	checkpointWhen: () => true,
});

/** Called inside every creation commit, including raw Tx creation and native Conversation.fork(). */
export async function initializeConversationMetadata(tx: Tx, conversation: ConversationRecord): Promise<void> {
	const metadata = await tx.doc(LoomConversationDoc, conversation.id);
	metadata.archived = false;
	metadata.hidden = false;
	metadata.createdAt = Date.now();
	if (conversation.parent !== undefined) metadata.title += FORK_TITLE_SUFFIX;
}

export type LoomConversationSummary = ConversationRecord & LoomConversationMetadata;
export type LoomConversationListOptions = {
	/** Omitted: both archived and active conversations. */
	archived?: boolean;
	/** Default false: owned specialist conversations stay out of the main list. */
	includeOwned?: boolean;
};

/** One committed list revision. Read through Tx, never through Harness while its commit holds the line. */
export function listLoomConversations(
	harness: Harness,
	options: LoomConversationListOptions,
	context: Context,
): Promise<LoomConversationSummary[]> {
	return harness.commit(async (tx) => {
		const conversations: ConversationRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanConversations({ order: "descending" }, 256, cursor);
			conversations.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		const rows: LoomConversationSummary[] = [];
		for (const conversation of conversations) {
			if (!options.includeOwned && conversation.owner !== undefined) continue;
			const { title, archived, hidden, createdAt } = await tx.doc(LoomConversationDoc, conversation.id);
			if (hidden) continue;
			if (options.archived !== undefined && archived !== options.archived) continue;
			rows.push({ ...conversation, title, archived, hidden, createdAt });
		}
		return rows;
	}, context);
}

export function setConversationTitle(harness: Harness, id: ConversationId, title: string, context: Context): Promise<void> {
	const normalized = title.trim() || DEFAULT_SESSION_TITLE;
	return harness.commit(async (tx) => {
		if (await tx.conversation(id) === undefined) throw new Error(`Unknown conversation: ${id}`);
		(await tx.doc(LoomConversationDoc, id)).title = normalized;
	}, context);
}

export function setConversationArchived(harness: Harness, id: ConversationId, archived: boolean, context: Context): Promise<void> {
	return harness.commit(async (tx) => {
		if (await tx.conversation(id) === undefined) throw new Error(`Unknown conversation: ${id}`);
		(await tx.doc(LoomConversationDoc, id)).archived = archived;
	}, context);
}

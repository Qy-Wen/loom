import {
	BACKGROUND_CONTEXT as context, clearPendingApprovals, configure,
	createChatExtensions, createToolResultStorage, LibraryRuntime, LoomApprovalsDoc, LoomConversationDoc,
	listLoomConversations, setConversationArchived, setConversationTitle, ToolGate, toolEventId, CompactionEntry, contextUsage, AgentDoc, LiveDoc, InboxDoc,
	DurableTrace, TraceStore, watchEvents, type LoomTraceRecord, type Submission, type SubmissionId, type SubmissionRecord, type Extension,
	type AgentChange, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord, type LoomSessionRecord, type LoomSessionSummary,
} from "@loom/agent/durable";
import { contentWithPlacedAssets, implicitSelectionAttachments, foldUserText, titleFromUserText, DEFAULT_SESSION_TITLE, type AssetRefAttachment, type ComposerImageInput, type UiSelectionFields, type LoomAgentOptions, type LoomTool } from "@loom/agent";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ChatSelection } from "@loom/agent/chat-models";
import type { AgentPermissionLevel, CommandAllow, ToolGateDecision } from "@loom/agent/tool-permission";

export type ChatServiceOptions = LoomAgentOptions & {
	/** The app owns the execution collection; this service never builds Providers. */
	models: Models;
	/** Resolve current availability when assigning a model; static defaults also support headless hosts. */
	chatDefault?: ChatSelection | (() => Promise<ChatSelection | undefined>);
	composer?: {
		getSelection?: () => UiSelectionFields | null;
		takeImages?: (id: string) => Promise<ComposerImageInput[]>;
		takeAssets?: (id: string) => Promise<AssetRefAttachment[]>;
	};
};
export type PreparedChatTurn = {
	readonly existingRequest: SubmissionRecord | undefined;
	/** Admit after the observer is attached, so fast replies cannot escape the live stream. */
	submit(): Promise<Submission>;
};
type ChatTurnOptions = { requestId?: string; clientMessageId?: string; whenBusy?: "reject" | "followUp" };


const idOf = <T extends ConversationId | EntryId>(id: string): T => {
	const parsed = Number(id);
	if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(parsed)) throw new Error("Invalid conversation ID");
	return parsed as T;
};

/** App-scoped chat rules and lifecycle; LibraryRuntime and durable own execution and recovery. */
export class ChatService {
	runtime: LibraryRuntime | undefined;
	readonly gate = new ToolGate();
	readonly #options: ChatServiceOptions;
	#instructions = "";
	readonly #agentDefaults: { -readonly [Key in keyof AgentChange]: AgentChange[Key] } = {};
	#unsubscribe: (() => void) | undefined;
	readonly #listeners = new Set<(rows: LoomSessionSummary[]) => void>();
	#revision = 0;
	readonly #onUsage?: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void;
	#usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	#trace?: DurableTrace;
	#tracePublisher?: (record: LoomTraceRecord | null) => void;
	/** Enable local tracing before opening a library. Diagnostics never cross the Chat transport. */
	setTracePublisher(publish: (record: LoomTraceRecord | null) => void) { this.#tracePublisher = publish; }
	listTraces(limit = 40, before?: { at: number; id: string }): LoomTraceRecord[] { return this.#trace?.store.list(limit, before) ?? []; }

	constructor(options: ChatServiceOptions, onUsage?: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void) { this.#options = { ...options }; this.#onUsage = onUsage; }
	readonly #chatSecrets = new Set<string>();
	setChatSecrets(values: readonly string[]) { for (const value of values) if (value) this.#chatSecrets.add(value); this.#trace?.setSecrets([...this.#chatSecrets]); }
	/** Saved conversation selections are never replaced by defaults. */
	setChatDefault(selection: ChatSelection | undefined) {
		this.#options.chatDefault = selection && structuredClone(selection);
	}
	private async defaultAgent(): Promise<AgentChange> {
		const value = this.#options.chatDefault;
		const selection = typeof value === "function" ? await value() : value;
		return selection ? { model: { provider: selection.provider, modelId: selection.modelId }, thinkingLevel: selection.thinkingLevel } : {};
	}
	private async ensureModel(conversation: Conversation): Promise<void> {
		if ((await conversation.agent(context)).model) return;
		const runtime = this.requireRuntime();
		const defaults = await this.defaultAgent();
		if (this.runtime !== runtime) throw new Error("The open library changed.");
		if (!defaults.model) return;
		await conversation.commit(async (tx) => {
			if ((await tx.doc(AgentDoc, conversation.id)).model || (await tx.doc(LiveDoc, conversation.id)).run
				|| (await tx.doc(InboxDoc, conversation.id)).items.length) return;
			await configure(tx, conversation.id, defaults);
		}, context);
	}
	getPermissionLevel() { return this.gate.level; }
	setPermissionLevel(level: AgentPermissionLevel) { this.gate.setLevel(level); }
	setCommandAllows(allows: readonly CommandAllow[]) { this.gate.allows = allows; }
	pendingCommandAllow(id: string) { return this.runtime ? this.gate.pendingCommandAllow(id, this.runtime.libraryPath) : undefined; }
	resolveToolGate(id: string, decision: ToolGateDecision) { return this.gate.resolve(id, decision); }
	setSystemPrompt(prompt: string) { this.#options.systemPrompt = prompt; }

	async openLibrary(root: string): Promise<void> {
		await this.close();
		if (this.#tracePublisher) {
			try {
				this.#trace = new DurableTrace(await TraceStore.open(root), (record) => this.#tracePublisher?.(record), () => { /* Diagnostics must not fail a run. */ });
				this.#trace.setSecrets([...this.#chatSecrets]);
			} catch { /* A read-only/unavailable diagnostic store does not prevent opening Chat. */ }
		}
		const permission = this.gate.extension(root, () => this.requireRuntime().harness);
		const sharedExtensions = [createToolResultStorage(root), ...(this.#trace ? [this.#trace.extension] : [])];
		const assembly = await this.assemble(root, permission, sharedExtensions);
		this.#models = this.#options.models;
		this.#agentDefaults.instructions = this.#instructions;
		try { this.runtime = await LibraryRuntime.open(root, {
			models: this.#trace?.models(this.#models) ?? this.#models, resume: false, extensions: [assembly.extension, permission, ...assembly.specialists, ...sharedExtensions],
			telemetry: this.#trace?.telemetry,
			settings: { extensions: [assembly.extension, permission, ...sharedExtensions] },
			agent: this.#agentDefaults,
			conversationCreated: async (tx, record) => {
				await assembly.conversationCreated(tx, record);
				await tx.doc(LoomApprovalsDoc, record.id);
				if (!record.parent) await tx.appendEntry(record.id, { kind: "loom.start", head: "self" });
			},
		}, context); }
		catch (error) { this.#trace?.stop(); this.#trace = undefined; throw error; }
		if (this.#trace) {
			try {
				this.#trace.attach(this.runtime.harness);
				for (const record of this.#trace.store.list().reverse()) this.#tracePublisher?.(record);
			}
			catch { this.#trace.stop(); this.#trace = undefined; }
		}
		await clearPendingApprovals(this.runtime.harness);
		this.#usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const baseline = await this.runtime.harness.usage(context);
		for (const row of Object.values(baseline.models)) for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) this.#usage[key] += row[key];
		this.#unsubscribe = this.runtime.harness.subscribeCommits((publication) => {
			if (publication.changes.some((change) => change.type === "document" && change.record.kind === "pi.usage")) void this.recordUsage();
			if (publication.changes.some((change) => change.type === "conversation" || change.type === "entry" || (change.type === "document" && (change.record.kind === LoomConversationDoc.definition.kind || change.record.kind === AgentDoc.definition.kind)))) void this.publish();
		});
		this.runtime.harness.resume();
		await this.publish();
	}
	async close(): Promise<void> {
		const runtime = this.runtime;
		this.#unsubscribe?.(); this.#unsubscribe = undefined;
		try { if (runtime) await runtime.close(context); }
		finally { this.#trace?.stop(); this.#trace = undefined; this.#tracePublisher?.(null); }
		if (this.runtime === runtime) this.runtime = undefined;
		await this.publish();
	}
	requireRuntime(): LibraryRuntime { if (!this.runtime) throw new Error("Open a library first."); return this.runtime; }
	async conversation(id: string): Promise<Conversation> {
		const handle = await this.requireRuntime().harness.conversation(idOf(id), context);
		if (!handle) throw new Error(`Conversation not found: ${id}`);
		return handle;
	}

	/** Common application rules for a new turn, an edit, and a queued follow-up. */
	async prepareTurn(id: string, text: string, options: ChatTurnOptions = {}): Promise<PreparedChatTurn> {
		const runtime = this.requireRuntime();
		const conversation = await this.conversation(id);
		const requestId = options.requestId;
		const existingRequest = requestId === undefined ? undefined : await runtime.harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context);
		if (existingRequest) return { existingRequest, submit: async () => (await runtime.harness.submission(existingRequest.id, context))! };
		await this.ensureModel(conversation);
		const record = await this.getSession(id);
		if (this.runtime !== runtime) throw new Error("The open library changed.");
		const images = await this.#options.composer?.takeImages?.(id) ?? [];
		const chips = await this.#options.composer?.takeAssets?.(id) ?? [];
		if (this.runtime !== runtime) throw new Error("The open library changed.");
		const raw = text.replaceAll("\u200b", "");
		const body = contentWithPlacedAssets(raw.trim() ? raw : "", chips);
		const attachments = implicitSelectionAttachments(chips, this.#options.composer?.getSelection?.(), record.messages);
		const folded = foldUserText(body, attachments);
		if (!folded.trim() && !images.length) throw new Error("Enter a message first.");
		if (record.title === DEFAULT_SESSION_TITLE && raw.trim()) await setConversationTitle(runtime.harness, conversation.id, titleFromUserText(raw), context);
		const content = images.length ? [{ type: "text" as const, text: folded }, ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))] : folded;
		return {
			existingRequest,
			submit: () => conversation.submit({ type: "input", content, whenBusy: options.whenBusy ?? "reject", requestId, entry: { kind: "loom.user", data: { text: body, clientMessageId: options.clientMessageId ?? "" } } }, context),
		};
	}

	async followUp(id: string, text: string, clientMessageId?: string): Promise<void> {
		await (await this.prepareTurn(id, text, { clientMessageId, whenBusy: "followUp" })).submit();
	}

	async waitForTurn(submission: Submission) {
		const settled = await submission.wait(context);
		if (settled.status === "unanswered" && settled.reason !== "aborted") throw new Error(typeof settled.detail === "string" ? settled.detail : settled.reason);
		return settled;
	}

	/** Pin observation and cancellation to this library, even if the app switches libraries later. */
	async connect(id: string) {
		const runtime = this.requireRuntime();
		const conversation = await this.conversation(id);
		return {
			prepareTurn: (text: string, options?: ChatTurnOptions) => {
				if (this.runtime !== runtime) throw new Error("The open library changed.");
				return this.prepareTurn(id, text, options);
			},
			watch: (childId = id) => watchEvents(runtime.harness, idOf<ConversationId>(childId), context),
			approvals: (childId = id) => runtime.harness.watchDoc(LoomApprovalsDoc, idOf<ConversationId>(childId), context),
			requestIdForInput: async (submissionId: SubmissionId | undefined) => submissionId === undefined ? undefined : (await (await runtime.harness.submission(submissionId, context))?.status(context))?.requestId,
			abort: () => conversation.abort(context),
		};
	}
	async isRunning(id: string): Promise<boolean> { return (await this.activeInputs(id)).submissions.length > 0; }
	async stop(id: string, runId?: string): Promise<boolean> {
		const { conversation, submissions } = await this.activeInputs(id);
		if (!submissions.length || (runId !== undefined && !submissions.some((row) => row.requestId === runId))) return false;
		await conversation.abort(context);
		return true;
	}
	private async activeInputs(id: string) {
		const runtime = this.requireRuntime();
		const conversation = await this.conversation(id);
		const submissions = (await runtime.harness.inspect(context)).submissions.filter((row) => row.conversationId === conversation.id && row.type === "input" && (row.status === "queued" || row.status === "placed"));
		return { conversation, submissions };
	}
	async listSessions(): Promise<LoomSessionSummary[]> {
		const runtime = this.runtime;
		if (!runtime) return [];
		return Promise.all((await listLoomConversations(runtime.harness, {}, context)).map(async (row) => ({
			id: String(row.id), title: row.title, status: row.archived ? "archived" as const : "open" as const, createdAt: row.createdAt,
			updatedAt: await this.lastMessageTimestamp((await runtime.harness.conversation(row.id, context))!) ?? row.createdAt,
		})));
	}
	async createSession() {
		const runtime = this.requireRuntime();
		const agent = await this.defaultAgent();
		if (this.runtime !== runtime) throw new Error("The open library changed.");
		const conversation = await runtime.createConversation({ agent }, context);
		return this.getSession(String(conversation.id));
	}
	async openSession(id: string) { await this.ensureModel(await this.conversation(id)); return this.getSession(id); }
	async getChatImage(id: string, entryId: string, contentIndex: number): Promise<{ data: string; mimeType: string } | undefined> {
		if (!Number.isSafeInteger(contentIndex) || contentIndex < 0) return undefined;
		const conversation = await this.conversation(id);
		const entry = (await conversation.entries({ maxEntryId: idOf<EntryId>(entryId) }, 1, undefined, context)).items[0];
		if (String(entry?.id) !== entryId) return undefined;
		const content = entry?.model?.[0]?.content;
		const part = Array.isArray(content) ? content[contentIndex] : undefined;
		return part?.type === "image" ? { data: part.data, mimeType: part.mimeType } : undefined;
	}
	async getSession(id: string, afterEntryId?: string): Promise<LoomSessionRecord> {
		const runtime = this.requireRuntime();
		const conversation = await this.conversation(id);
		const metadata = await runtime.harness.snapshot(LoomConversationDoc, conversation.id, context);
		const entries = await this.history(conversation, afterEntryId);
		const messages = entries.flatMap((entry) => (entry.model ?? []).filter((message) => message.role !== "system").map((message) => ({
			...message, id: String(entry.id),
			...(message.role === "assistant" ? { content: message.content.map((part) => part.type === "toolCall" ? { ...part, id: toolEventId(entry.conversationId, part.id) } : part) } : {}),
			...(message.role === "toolResult" ? { toolCallId: toolEventId(entry.conversationId, message.toolCallId) } : {}),
			...(entry.kind === "loom.user" ? { displayContent: (entry.data as { text?: string })?.text, clientMessageId: (entry.data as { clientMessageId?: string })?.clientMessageId } : {}),
		})));
		const agent = await conversation.agent(context);
		const ref = agent.model;
		const model = ref && this.#models?.getModel(ref.provider, ref.modelId);
		const usage = ref && model && model.contextWindow > 0 ? contextUsage(await conversation.context(context), ref, model.contextWindow) : undefined;
		return { id, title: metadata?.title ?? "New session", status: metadata?.archived ? "archived" : "open", createdAt: metadata?.createdAt ?? 0, updatedAt: afterEntryId ? await this.lastMessageTimestamp(conversation) ?? metadata?.createdAt ?? 0 : messages.at(-1)?.timestamp ?? metadata?.createdAt ?? 0, messages, context: usage,
			model: ref ? { provider: ref.provider, modelId: ref.modelId, ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}) } : undefined };
	}
	async setSessionName(id: string, title: string) { await setConversationTitle(this.requireRuntime().harness, idOf(id), title, context); }
	/** Persist a conversation's model/thinking selection. Busy conversations reject; the change applies from the next request. */
	async setSessionModel(id: string, selection: { provider: string; modelId: string; thinkingLevel?: import("@earendil-works/pi-ai").ModelThinkingLevel }): Promise<LoomSessionRecord> {
		const runtime = this.requireRuntime();
		const conversation = await this.conversation(id);
		await runtime.harness.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversation.id);
			const inbox = await tx.doc(InboxDoc, conversation.id);
			if (live.run || inbox.items.length) throw new Error("Conversation is busy");
			for (const status of ["pending", "running", "waiting", "completing"] as const) {
				if ((await tx.scanTasks({ conversationId: conversation.id, status }, 1)).items.length) throw new Error("Conversation is busy");
			}
		}, context);
		await conversation.configure({
			model: { provider: selection.provider, modelId: selection.modelId },
			...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
		}, context);
		return this.getSession(id);
	}
	async archiveSession(id: string) {
		const conversation = await this.conversation(id);
		await conversation.commit(async (tx) => {
			let hasMessages = false;
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanEntries({ conversationId: conversation.id }, 256, cursor);
				hasMessages = page.items.some((entry) => !CompactionEntry.is(entry) && entry.model?.some((message) => message.role !== "system"));
				cursor = page.next;
			} while (!hasMessages && cursor !== undefined);
			const live = await tx.doc(LiveDoc, conversation.id);
			const inbox = await tx.doc(InboxDoc, conversation.id);
			const metadata = await tx.doc(LoomConversationDoc, conversation.id);
			// Closing an unused tab is not history. Keep durable ancestry, but hide it from both lists.
			if (!hasMessages && !live.run && !inbox.items.some((item) => item.mode !== "write")) metadata.hidden = true;
			else metadata.archived = true;
		}, context);
	}
	async unarchiveSession(id: string) { await setConversationArchived(this.requireRuntime().harness, idOf(id), false, context); }
	async deleteSession(id: string) {
		const conversation = await this.conversation(id);
		await conversation.abort(context);
		await conversation.commit(async (tx) => { (await tx.doc(LoomConversationDoc, conversation.id)).hidden = true; }, context);
	}
	async forkBefore(id: string, entryId: string, model?: ChatSelection) {
		const conversation = await this.conversation(id);
		await conversation.abort(context);
		const history = (await conversation.entries({ maxEntryId: idOf<EntryId>(entryId) }, 2, undefined, context)).items;
		if (String(history[0]?.id) !== entryId) throw new Error("Entry not found");
		// Fork before the user entry, not at it; a reset provides an empty-context anchor for first-entry forks.
		const at = history[1]?.id;
		if (!at) throw new Error("Cannot fork before the conversation's start anchor");
		const fork = await conversation.fork(at, {
			ownership: { kind: "ownerless" },
			agent: model ? { model: { provider: model.provider, modelId: model.modelId }, thinkingLevel: model.thinkingLevel } : undefined,
		}, context);
		return this.getSession(String(fork.id));
	}
	async branchBefore(id: string, entryId: string, model?: ChatSelection) {
		const fork = await this.forkBefore(id, entryId, model);
		await this.archiveSession(id);
		return fork;
	}
	#models: Models | undefined;
	/** Guard Provider edits/publication atomically against public Session admission; no scheduler queue. */
	async withIdleChatProviders<T>(ids: readonly string[], operation: () => Promise<T>): Promise<T> {
		const runtime = this.runtime;
		if (!runtime || !ids.length) return operation();
		return runtime.harness.commit(async (tx) => {
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanConversations({}, 256, cursor);
				for (const record of page.items) {
					const agent = await tx.doc(AgentDoc, record.id);
					if (!agent.model || !ids.includes(agent.model.provider)) continue;
					const live = await tx.doc(LiveDoc, record.id);
					const inbox = await tx.doc(InboxDoc, record.id);
					if (live.run || inbox.items.length) throw new Error("Chat provider is busy");
					for (const status of ["pending", "running", "waiting", "completing"] as const) {
						if ((await tx.scanTasks({ conversationId: record.id, status }, 1)).items.length) throw new Error("Chat provider is busy");
					}
				}
				cursor = page.next;
			} while (cursor !== undefined);
			// This callback must not call Harness/Session APIs while their public mutation line is held.
			return operation();
		}, context);
	}
	async setInstructions(text: string) {
		this.#instructions = text;
		this.#agentDefaults.instructions = text;
		if (!this.runtime) return;
		for (const row of await listLoomConversations(this.runtime.harness, {}, context)) {
			await (await this.runtime.harness.conversation(row.id, context))!.configure({ instructions: text }, context);
		}
	}
	async setTools(tools: LoomTool[]) {
		this.#options.tools = tools;
		if (!this.runtime) return;
		const permission = this.gate.extension(this.runtime.libraryPath, () => this.requireRuntime().harness);
		const assembly = await this.assemble(this.runtime.libraryPath, permission);
		this.runtime.registry.install(assembly.extension);
		for (const child of assembly.specialists) this.runtime.registry.install(child);
	}
	/** UI transcript is fork-aware history, not the model's compacted active context. */
	private async history(conversation: Conversation, afterEntryId?: string): Promise<EntryRecord[]> {
		const tail = (await conversation.entries({}, 1, undefined, context)).items[0]?.id;
		if (tail === undefined) return [];
		const entries: EntryRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await conversation.entries({ order: "ascending", maxEntryId: tail, ...(afterEntryId ? { minEntryId: (idOf<EntryId>(afterEntryId) + 1) as EntryId } : {}) }, 256, cursor, context);
			entries.push(...page.items.filter((entry) => !CompactionEntry.is(entry)));
			cursor = page.next;
		} while (cursor !== undefined);
		return entries;
	}
	private async lastMessageTimestamp(conversation: Conversation): Promise<number | undefined> {
		let cursor: Cursor | undefined;
		do {
			const page = await conversation.entries({}, 32, cursor, context);
			for (const entry of page.items) {
				if (CompactionEntry.is(entry)) continue;
				const message = entry.model?.findLast((message) => message.role !== "system");
				if (message) return message.timestamp;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return undefined;
	}
	private async recordUsage() {
		const runtime = this.runtime; if (!runtime) return;
		try {
			const usage = await runtime.harness.usage(context);
			if (this.runtime !== runtime) return;
			const next = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			for (const row of Object.values(usage.models)) for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) next[key] += row[key];
			const delta = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) delta[key] = Math.max(0, next[key] - this.#usage[key]);
			this.#usage = next; if (Object.values(delta).some((value) => value > 0)) this.#onUsage?.(delta);
		} catch { /* A closing runtime cannot publish usage. */ }
	}
	private assemble(root: string, permission: Extension, sharedExtensions: readonly Extension[] = [createToolResultStorage(root), ...(this.#trace ? [this.#trace.extension] : [])]) {
		return createChatExtensions(root, { systemPrompt: this.#options.systemPrompt, tools: this.#options.tools, permission, sharedExtensions });
	}

	subscribeSessions(listener: (rows: LoomSessionSummary[]) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
	async publish() {
		const revision = ++this.#revision;
		try { const rows = await this.listSessions(); if (revision === this.#revision) for (const listener of this.#listeners) listener(rows); }
		catch { /* A closing library will publish its empty list after close. */ }
	}
}

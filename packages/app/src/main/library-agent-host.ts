import {
	BACKGROUND_CONTEXT as context, buildChatModels, chatEndpointReady, clearPendingApprovals,
	createLibraryExtension, createModels, createSpecialistExtension, partitionLibraryTools, createWorkspaceTools, toDurableTool, LibraryAgent, LoomApprovalsDoc, LoomConversationDoc,
	listLoomConversations, setConversationArchived, setConversationTitle, ToolGate, toolEventId, CompactionEntry, contextUsage, AgentDoc, LiveDoc, InboxDoc,
	DurableTrace, TraceStore, type LoomTraceRecord,
	type AgentChange, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord, type LoomSessionRecord, type LoomSessionSummary,
} from "@loom/agent/durable";
import type { LoomAgentOptions, LoomChatEndpoint, LoomTool } from "@loom/agent";
import type { AgentPermissionLevel, CommandAllow, ToolGateDecision } from "@loom/agent/tool-permission";

const idOf = <T extends ConversationId | EntryId>(id: string): T => {
	const parsed = Number(id);
	if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(parsed)) throw new Error("Invalid conversation ID");
	return parsed as T;
};

/** App-only lifecycle/DTO boundary. It owns a LibraryAgent, never reimplements lanes or generation. */
export class LibraryAgentHost {
	owner: LibraryAgent | undefined;
	readonly gate = new ToolGate();
	readonly #options: LoomAgentOptions;
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

	constructor(options: LoomAgentOptions, onUsage?: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void) { this.#options = { ...options }; this.#onUsage = onUsage; }
	getPermissionLevel() { return this.gate.level; }
	setPermissionLevel(level: AgentPermissionLevel) { this.gate.setLevel(level); }
	setCommandAllows(allows: readonly CommandAllow[]) { this.gate.allows = allows; }
	pendingCommandAllow(id: string) { return this.owner ? this.gate.pendingCommandAllow(id, this.owner.libraryPath) : undefined; }
	resolveToolGate(id: string, decision: ToolGateDecision) { return this.gate.resolve(id, decision); }
	setSystemPrompt(prompt: string) { this.#options.systemPrompt = prompt; }

	async openLibrary(root: string): Promise<void> {
		await this.close();
		const ready = chatEndpointReady(this.#options.chat);
		const chat = ready ? buildChatModels(this.#options.chat!) : undefined;
		if (this.#tracePublisher) {
			try {
				this.#trace = new DurableTrace(await TraceStore.open(root), (record) => this.#tracePublisher?.(record), () => { /* Diagnostics must not fail a run. */ });
				this.#trace.setSecrets(this.#options.chat?.apiKey ? [this.#options.chat.apiKey] : []);
			} catch { /* A read-only/unavailable diagnostic store does not prevent opening Chat. */ }
		}
		const permission = this.gate.extension(root, () => this.requireOwner().harness);
		const { assembly, specialists } = await this.assemble(root, permission);
		this.#models = chat?.models ?? createModels();
		this.#agentDefaults.model = chat ? { provider: chat.model.provider, modelId: chat.model.id } : undefined;
		this.#agentDefaults.instructions = this.#instructions;
		const traceExtensions = this.#trace ? [this.#trace.extension] : [];
		try { this.owner = await LibraryAgent.open(root, {
			models: this.#trace?.models(this.#models) ?? this.#models, resume: false, extensions: [assembly.extension, permission, ...specialists, ...traceExtensions],
			settings: { extensions: [assembly.extension, permission, ...traceExtensions] },
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
				await this.#trace.start(this.owner.harness);
				for (const record of this.#trace.store.list().reverse()) this.#tracePublisher?.(record);
			}
			catch { this.#trace.stop(); this.#trace = undefined; }
		}
		await clearPendingApprovals(this.owner.harness);
		this.#usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const baseline = await this.owner.harness.usage(context);
		for (const row of Object.values(baseline.models)) for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) this.#usage[key] += row[key];
		this.#unsubscribe = this.owner.harness.subscribeCommits((publication) => {
			if (publication.changes.some((change) => change.type === "document" && change.record.kind === "pi.usage")) void this.recordUsage();
			if (publication.changes.some((change) => change.type === "conversation" || change.type === "entry" || (change.type === "document" && (change.record.kind === LoomConversationDoc.definition.kind || change.record.kind === AgentDoc.definition.kind)))) void this.publish();
		});
		this.owner.harness.resume();
		await this.publish();
	}
	async close(): Promise<void> {
		const owner = this.owner;
		this.#unsubscribe?.(); this.#unsubscribe = undefined;
		try { if (owner) await owner.close(context); }
		finally { this.#trace?.stop(); this.#trace = undefined; this.#tracePublisher?.(null); }
		if (this.owner === owner) this.owner = undefined;
		await this.publish();
	}
	requireOwner(): LibraryAgent { if (!this.owner) throw new Error("Open a library first."); return this.owner; }
	async conversation(id: string): Promise<Conversation> {
		const handle = await this.requireOwner().harness.conversation(idOf(id), context);
		if (!handle) throw new Error(`Conversation not found: ${id}`);
		return handle;
	}
	async listSessions(): Promise<LoomSessionSummary[]> {
		const owner = this.owner;
		if (!owner) return [];
		return Promise.all((await listLoomConversations(owner.harness, {}, context)).map(async (row) => ({
			id: String(row.id), title: row.title, status: row.archived ? "archived" as const : "open" as const, createdAt: row.createdAt,
			updatedAt: await this.lastMessageTimestamp((await owner.harness.conversation(row.id, context))!) ?? row.createdAt,
		})));
	}
	async createSession() { const conversation = await this.requireOwner().createConversation({}, context); return this.getSession(String(conversation.id)); }
	async openSession(id: string) { return this.getSession(id); }
	async getSession(id: string): Promise<LoomSessionRecord> {
		const owner = this.requireOwner();
		const conversation = await this.conversation(id);
		const metadata = await owner.harness.snapshot(LoomConversationDoc, conversation.id, context);
		const entries = await this.history(conversation);
		const messages = entries.flatMap((entry) => (entry.model ?? []).filter((message) => message.role !== "system").map((message) => ({
			...message, id: String(entry.id),
			...(message.role === "assistant" ? { content: message.content.map((part) => part.type === "toolCall" ? { ...part, id: toolEventId(entry.conversationId, part.id) } : part) } : {}),
			...(message.role === "toolResult" ? { toolCallId: toolEventId(entry.conversationId, message.toolCallId) } : {}),
			...(entry.kind === "loom.user" ? { displayContent: (entry.data as { text?: string })?.text } : {}),
		})));
		const agent = await conversation.agent(context);
		const ref = agent.model;
		const model = ref && this.#models?.getModel(ref.provider, ref.modelId);
		const usage = ref && model && model.contextWindow > 0 ? contextUsage(await conversation.context(context), ref, model.contextWindow) : undefined;
		return { id, title: metadata?.title ?? "New session", status: metadata?.archived ? "archived" : "open", createdAt: metadata?.createdAt ?? 0, updatedAt: messages.at(-1)?.timestamp ?? metadata?.createdAt ?? 0, messages, context: usage };
	}
	async setSessionName(id: string, title: string) { await setConversationTitle(this.requireOwner().harness, idOf(id), title, context); }
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
	async unarchiveSession(id: string) { await setConversationArchived(this.requireOwner().harness, idOf(id), false, context); }
	async deleteSession(id: string) {
		const conversation = await this.conversation(id);
		await conversation.abort(context);
		await conversation.commit(async (tx) => { (await tx.doc(LoomConversationDoc, conversation.id)).hidden = true; }, context);
	}
	async forkBefore(id: string, entryId: string) {
		const conversation = await this.conversation(id);
		await conversation.abort(context);
		const history = (await conversation.entries({ maxEntryId: idOf<EntryId>(entryId) }, 2, undefined, context)).items;
		if (String(history[0]?.id) !== entryId) throw new Error("Entry not found");
		// Fork before the user entry, not at it; a reset provides an empty-context anchor for first-entry forks.
		const at = history[1]?.id;
		if (!at) throw new Error("Cannot fork before the conversation's start anchor");
		const fork = await conversation.fork(at, { ownership: { kind: "ownerless" } }, context);
		return this.getSession(String(fork.id));
	}
	async branchBefore(id: string, entryId: string) {
		const fork = await this.forkBefore(id, entryId);
		await this.archiveSession(id);
		return fork;
	}
	async setChat(chat: LoomChatEndpoint | undefined) {
		this.#options.chat = chat;
		this.#trace?.setSecrets(chat?.apiKey ? [chat.apiKey] : []);
		const owner = this.owner;
		if (!owner) return;
		const built = chatEndpointReady(chat) ? buildChatModels(chat) : undefined;
		this.#agentDefaults.model = built ? { provider: built.model.provider, modelId: built.model.id } : undefined;
		// Provider object replacement is supported without replacing the Harness's Models collection.
		if (built) {
			this.#models?.setProvider(built.models.getProvider(built.model.provider)!);
			for (const row of await listLoomConversations(owner.harness, { includeOwned: true }, context)) {
				await (await owner.harness.conversation(row.id, context))!.configure({ model: { provider: built.model.provider, modelId: built.model.id } }, context);
			}
		} else this.#models?.deleteProvider("loom-chat");
		// Context-window-only edits and disabling Chat may not change pi.agent.
		await this.publish();
	}
	#models: ReturnType<typeof createModels> | undefined;
	async setInstructions(text: string) {
		this.#instructions = text;
		this.#agentDefaults.instructions = text;
		if (!this.owner) return;
		for (const row of await listLoomConversations(this.owner.harness, {}, context)) {
			await (await this.owner.harness.conversation(row.id, context))!.configure({ instructions: text }, context);
		}
	}
	async setTools(tools: LoomTool[]) {
		this.#options.tools = tools;
		if (!this.owner) return;
		const permission = this.gate.extension(this.owner.libraryPath, () => this.requireOwner().harness);
		const { assembly, specialists } = await this.assemble(this.owner.libraryPath, permission);
		this.owner.registry.install(assembly.extension);
		for (const child of specialists) this.owner.registry.install(child);
	}
	/** UI transcript is fork-aware history, not the model's compacted active context. */
	private async history(conversation: Conversation): Promise<EntryRecord[]> {
		const tail = (await conversation.entries({}, 1, undefined, context)).items[0]?.id;
		if (tail === undefined) return [];
		const entries: EntryRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await conversation.entries({ order: "ascending", maxEntryId: tail }, 256, cursor, context);
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
		const owner = this.owner; if (!owner) return;
		try {
			const usage = await owner.harness.usage(context);
			if (this.owner !== owner) return;
			const next = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			for (const row of Object.values(usage.models)) for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) next[key] += row[key];
			const delta = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) delta[key] = Math.max(0, next[key] - this.#usage[key]);
			this.#usage = next; if (Object.values(delta).some((value) => value > 0)) this.#onUsage?.(delta);
		} catch { /* A closing owner cannot publish usage. */ }
	}
	private async assemble(root: string, permission: ReturnType<ToolGate["extension"]>) {
		const grouped = partitionLibraryTools(this.#options.tools ?? []);
		const workspace = await createWorkspaceTools();
		const traceExtensions = this.#trace ? [this.#trace.extension] : [];
		const retrieve = createSpecialistExtension("retrieve", [...workspace.filter((tool) => tool.name === "read"), ...grouped.retrieve.map(toDurableTool)], permission, traceExtensions);
		const create = createSpecialistExtension("create", [...workspace.filter((tool) => ["read", "edit", "write", "bash"].includes(tool.name)), ...grouped.create.map(toDurableTool)], permission, traceExtensions);
		const assembly = await createLibraryExtension(root, { systemPrompt: this.#options.systemPrompt, tools: grouped.parent });
		return { assembly: { ...assembly, extension: { ...assembly.extension, tools: [...assembly.extension.tools!, retrieve.tool, create.tool] } }, specialists: [retrieve.child, create.child] };
	}
	subscribeSessions(listener: (rows: LoomSessionSummary[]) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
	async publish() {
		const revision = ++this.#revision;
		try { const rows = await this.listSessions(); if (revision === this.#revision) for (const listener of this.#listeners) listener(rows); }
		catch { /* A closing library will publish its empty list after close. */ }
	}
}

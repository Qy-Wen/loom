import { resolve, join } from "node:path";
import {
	AgentHarness,
	BACKGROUND_CONTEXT,
	DEFAULT_COMPACTION_SETTINGS,
	JsonlSessionRepo,
	calculateContextTokens,
	estimateContextTokens,
	laneConfig,
	laneState,
	value,
	type AgentHarness as Harness,
	type AgentLane,
	type AgentMessage,
	type JsonlSessionMetadata,
	type Session,
} from "#vendor/pi-agent";
import { randomUUID } from "node:crypto";
import { buildChatModels, chatEndpointReady, DEFAULT_CHAT_CONTEXT_WINDOW, toProviderMessages } from "./pi-adapter.ts";
import { createWorkspaceTools, toHarnessTool, type WorkspaceTools } from "./pi-tools.ts";
import type {
	LoomAgentEvent,
	LoomAgentOptions,
	LoomChatEndpoint,
	LoomPromptOptions,
	LoomTool,
	LoomTranscriptMessage,
} from "./types.ts";

const MAIN = "main";
const DEFAULT_TITLE = "New session";
const ARCHIVED = value<"open" | "archived">("loom.session", "status");
const STOP_NOTE = "The user pressed Stop. This turn was cancelled on purpose, not because of an error.";
const CONTEXT = BACKGROUND_CONTEXT;

type OpenSession = {
	session: Session<JsonlSessionMetadata>;
	harness?: Harness;
	lane?: AgentLane;
	recovering?: Promise<void>;
	cancelRecovery?: boolean;
};

/** Assistant messages that carry a non-empty provider usage block after a compaction boundary. */
function hasReportedUsage(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	const usage = (message as { usage?: { totalTokens?: number; input: number; output: number; cacheRead: number; cacheWrite: number } }).usage;
	if (!usage) return false;
	return calculateContextTokens(usage as Parameters<typeof calculateContextTokens>[0]) > 0;
}

type ActiveRun = { lane: AgentLane; operationId: string; reason?: "user"; cancelRequested?: boolean; done: Promise<void> };

export interface HarnessSessionSummary {
	id: string;
	title: string;
	status: "open" | "archived";
	createdAt: number;
	updatedAt: number;
}

/** Context usage for the session's active path; tokens/percent are null after compaction until the next response. */
export interface HarnessContextUsage {
	tokens: number | null;
	window: number;
	percent: number | null;
}

export interface HarnessSessionRecord extends HarnessSessionSummary {
	messages: LoomTranscriptMessage[];
	context: HarnessContextUsage | undefined;
}

/** Sole owner of Pi's file-backed sessions and live Harness instances for one library. */
export class HarnessSessionManager {
	private readonly options: LoomAgentOptions;
	private readonly onUsage?: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void;
	private root: string | undefined;
	private repo: JsonlSessionRepo | undefined;
	private workspace: WorkspaceTools | undefined;
	private readonly handles = new Map<string, OpenSession>();
	private readonly creating = new Set<Promise<HarnessSessionRecord>>();
	private readonly operations = new Map<string, Promise<void>>();
	private readonly preparing = new Map<string, { cancelled: boolean; done: Promise<void>; finish: () => void }>();
	private readonly running = new Map<string, ActiveRun>();
	private closing = false;
	private readonly listeners = new Set<(sessions: HarnessSessionSummary[]) => void>();
	private transition: Promise<void> = Promise.resolve();
	private recovery: { cancelled: boolean; done: Promise<void> } | undefined;
	private deferredRecovery = false;
	private readonly initializing = new Map<string, Promise<OpenSession & { harness: Harness; lane: AgentLane }>>();

	constructor(options: LoomAgentOptions, onUsage?: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void) {
		this.options = { ...options, tools: [...(options.tools ?? [])] };
		this.onUsage = onUsage;
	}

	private async serializeTransition<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.transition;
		let finish!: () => void;
		this.transition = new Promise<void>((resolve) => { finish = resolve; });
		await previous;
		try {
			return await operation();
		} finally {
			finish();
		}
	}

	openLibrary(root: string, options: { deferRecovery?: boolean } = {}): Promise<void> {
		return this.serializeTransition(async () => {
			await this.closeLibrary();
			this.root = resolve(root);
			this.workspace = createWorkspaceTools(this.root);
			this.repo = new JsonlSessionRepo({
				fileSystem: this.workspace.toolContext.env,
				sessionsRoot: join(this.root, ".loom", "harness-sessions"),
			});
			this.deferredRecovery = options.deferRecovery === true;
			if (!this.deferredRecovery && chatEndpointReady(this.options.chat)) this.startRecovery();
		});
	}

	/** Await automatic recovery when a caller explicitly needs its final history. */
	waitForRecovery(): Promise<void> {
		return this.recovery?.done ?? Promise.resolve();
	}

	private startRecovery(): void {
		if (this.recovery || !this.repo || !chatEndpointReady(this.options.chat)) return;
		const recovery = { cancelled: false, done: Promise.resolve() };
		recovery.done = this.recoverSessions(recovery).finally(() => {
			if (this.recovery === recovery) this.recovery = undefined;
		});
		this.recovery = recovery;
		void recovery.done.catch((error) => {
			if (!recovery.cancelled) console.error("Failed to restore Harness sessions", error);
		});
	}

	private async stopRecovery(): Promise<void> {
		const recovery = this.recovery;
		if (!recovery) return;
		recovery.cancelled = true;
		for (const open of this.handles.values()) {
			open.cancelRecovery = true;
			if (!open.recovering || !open.lane) continue;
			const stopped = await open.lane.abort(CONTEXT);
			if (!stopped.ok && stopped.error._tag !== "NoActiveOperation") throw stopped.error;
		}
		try {
			await recovery.done;
		} catch {
			// A cancelled scan may have observed the library closing.
		}
	}

	private requireRepo(): JsonlSessionRepo {
		if (this.closing || !this.repo || !this.root) throw new Error("No library is open");
		return this.repo;
	}

	private async metadata(id: string): Promise<JsonlSessionMetadata> {
		const found = (await this.requireRepo().list({ cwd: this.root }, CONTEXT)).find((row) => row.id === id);
		if (!found) throw new Error(`Session not found: ${id}`);
		return found;
	}

	private async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.operations.get(id);
		let finish!: () => void;
		const current = new Promise<void>((resolve) => { finish = resolve; });
		this.operations.set(id, current);
		try {
			if (previous) await previous;
			return await operation();
		} finally {
			if (this.operations.get(id) === current) this.operations.delete(id);
			finish();
		}
	}

	private withSession<T>(id: string, read: (open: OpenSession) => Promise<T>): Promise<T> {
		return this.exclusive(id, async () => {
			const existing = this.handles.get(id);
			if (existing) return read(existing);
			const metadata = await this.metadata(id);
			const session = await this.requireRepo().open(metadata, CONTEXT);
			try {
				return await read({ session });
			} finally {
				await session.close(CONTEXT);
			}
		});
	}

	private acquire(id: string): Promise<OpenSession> {
		return this.exclusive(id, async () => {
			const existing = this.handles.get(id);
			if (existing) return existing;
			const metadata = await this.metadata(id);
			const session = await this.requireRepo().open(metadata, CONTEXT);
			const opened = { session };
			this.handles.set(id, opened);
			return opened;
		});
	}

	/** Estimate context usage on the active path; null after compaction until a fresh assistant usage arrives. */
	private contextUsage(entries: readonly { type: string; message?: AgentMessage }[]): HarnessContextUsage | undefined {
		const chat = this.options.chat;
		if (!chatEndpointReady(chat)) return undefined;
		const window = chat.contextWindow ?? DEFAULT_CHAT_CONTEXT_WINDOW;
		// Mirror pi's post-compaction rule: pre-compaction usage no longer reflects context size.
		let newestCompaction = -1;
		for (let index = entries.length - 1; index >= 0; index--) {
			if (entries[index]!.type === "compaction") { newestCompaction = index; break; }
		}
		const context: AgentMessage[] = [];
		for (let index = newestCompaction + 1; index < entries.length; index++) {
			const entry = entries[index]!;
			if (entry.type !== "message") continue;
			const message = entry.message!;
			if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "deferred")) continue;
			context.push(message);
		}
		if (newestCompaction >= 0 && !context.some(hasReportedUsage)) {
			return { tokens: null, window, percent: null };
		}
		const estimate = estimateContextTokens(context);
		return { tokens: estimate.tokens, window, percent: (estimate.tokens / window) * 100 };
	}

	private async summary(metadata: JsonlSessionMetadata, session?: Session<JsonlSessionMetadata>): Promise<HarnessSessionSummary> {
		if (!session) return this.withSession(metadata.id, (open) => this.summary(metadata, open.session));
		return {
			id: metadata.id,
			title: (await session.getName(CONTEXT)) ?? DEFAULT_TITLE,
			status: (await session.getValue(ARCHIVED, CONTEXT))?.value ?? "open",
			createdAt: metadata.createdAt,
			updatedAt: Math.max(metadata.createdAt, metadata.modifiedAt),
		};
	}

	async listSessions(): Promise<HarnessSessionSummary[]> {
		const metadata = await this.requireRepo().list({ cwd: this.root }, CONTEXT);
		const summaries: HarnessSessionSummary[] = [];
		for (const row of metadata) summaries.push(await this.summary(row));
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
	}

	private async notify(): Promise<void> {
		if (this.listeners.size === 0) return;
		const sessions = await this.listSessions();
		for (const listener of this.listeners) listener(sessions);
	}

	subscribeSessions(listener: (sessions: HarnessSessionSummary[]) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	createSession(): Promise<HarnessSessionRecord> {
		const pending = this.createSessionInCurrentLibrary();
		this.creating.add(pending);
		void pending.then(() => this.creating.delete(pending), () => this.creating.delete(pending));
		return pending;
	}

	private async createSessionInCurrentLibrary(): Promise<HarnessSessionRecord> {
		const repo = this.requireRepo();
		const session = await repo.create({ cwd: this.root! }, CONTEXT);
		try {
			await session.setName(DEFAULT_TITLE, CONTEXT);
			await session.createBranch(MAIN, null, CONTEXT);
		} catch (error) {
			await session.close(CONTEXT);
			await repo.delete(session.metadata, CONTEXT);
			throw error;
		}
		this.handles.set(session.metadata.id, { session });
		const record = await this.getSession(session.metadata.id);
		await this.notify();
		return record;
	}

	async getSession(id: string): Promise<HarnessSessionRecord> {
		const metadata = await this.metadata(id);
		return this.withSession(id, async ({ session }) => {
			const branch = await session.branch(MAIN, CONTEXT);
			const entries = branch ? await branch.findEntries({ order: "oldestFirst" }, CONTEXT) : [];
			return {
				...await this.summary(metadata, session),
				messages: entries.flatMap((entry) => {
					if (entry.type === "message") return [{ ...entry.message, id: entry.id } as LoomTranscriptMessage];
					if (entry.type === "compaction") {
						return [{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: entry.timestamp, id: entry.id } as LoomTranscriptMessage];
					}
					return [];
				}),
				context: this.contextUsage(entries),
			};
		});
	}

	async openSession(id: string): Promise<HarnessSessionRecord> {
		await this.acquire(id);
		return this.getSession(id);
	}

	async setSessionName(id: string, title: string): Promise<void> {
		await this.withSession(id, ({ session }) => session.setName(title, CONTEXT));
		await this.notify();
	}

	async archiveSession(id: string): Promise<void> {
		await this.abort(id);
		await this.withSession(id, ({ session }) => session.setValue(ARCHIVED, "archived", CONTEXT));
		await this.release(id);
		await this.notify();
	}

	async unarchiveSession(id: string): Promise<void> {
		await this.withSession(id, ({ session }) => session.setValue(ARCHIVED, "open", CONTEXT));
		await this.notify();
	}

	async deleteSession(id: string): Promise<void> {
		await this.abort(id);
		await this.release(id);
		await this.requireRepo().delete(await this.metadata(id), CONTEXT);
		await this.notify();
	}

	private release(id: string): Promise<void> {
		return this.exclusive(id, async () => {
			const open = this.handles.get(id);
			if (!open) return;
			this.handles.delete(id);
			try {
				if (open.recovering) await open.recovering;
			} finally {
				if (open.harness) await open.harness.close(CONTEXT);
				else await open.session.close(CONTEXT);
			}
		});
	}

	private async ensureHarness(id: string): Promise<OpenSession & { harness: Harness; lane: AgentLane }> {
		const existing = this.initializing.get(id);
		if (existing) return existing;
		const initializing = (async () => {
		const open = await this.acquire(id);
		if (!open.harness || !open.lane) {
			const chat = this.options.chat;
			if (!chatEndpointReady(chat)) throw new Error("Chat is not configured. Set base URL and model in Settings.");
			const { models, model } = buildChatModels(chat);
			const workspace = this.workspace!;
			const tools = [...workspace.tools, ...(this.options.tools ?? []).map(toHarnessTool)];
			const { harness, open: pending } = await AgentHarness.create({
				session: open.session,
				models,
				model,
				tools,
				toolContext: workspace.toolContext,
				systemPrompt: () => this.options.systemPrompt ?? "",
				toProviderMessages,
				compaction: DEFAULT_COMPACTION_SETTINGS,
				entryProjectors: { loom_user_stop: () => [{ role: "user", content: STOP_NOTE, timestamp: Date.now() }] },
			}, CONTEXT);
			open.harness = harness;
			open.lane = await harness.lane(MAIN, CONTEXT);
			const stored = (await open.session.getValue(laneConfig(MAIN), CONTEXT))?.value;
			if (stored?.model.provider !== model.provider || stored.model.modelId !== model.id) {
				await open.lane.setModel({ provider: model.provider, modelId: model.id }, CONTEXT);
			}
			const names = tools.map((tool) => tool.name);
			if (stored?.activeToolNames.length !== names.length || stored.activeToolNames.some((name, index) => name !== names[index])) {
				await open.lane.setActiveTools(names, CONTEXT);
			}
			harness.events.on("usage", (event) => {
				if (event.row.adjustment) return;
				const usage = event.row.usage;
				this.onUsage?.({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
			});
			if (pending.length > 0) {
				if (open.cancelRecovery || this.preparing.get(id)?.cancelled || this.closing) {
					for (const operation of pending) {
						const lane = await harness.lane(operation.lane, CONTEXT);
						const stopped = await lane.abort(CONTEXT);
						if (!stopped.ok && stopped.error._tag !== "NoActiveOperation") throw stopped.error;
					}
				} else {
					const resuming = (async () => {
						for (const operation of pending) {
							const lane = await harness.lane(operation.lane, CONTEXT);
							if (open.cancelRecovery) {
								const stopped = await lane.abort(CONTEXT);
								if (!stopped.ok && stopped.error._tag !== "NoActiveOperation") throw stopped.error;
								continue;
							}
							const result = await lane.resume(CONTEXT);
							if (!result.ok && result.error._tag !== "NothingToResume") throw result.error;
							if (result.ok && result.value.status === "suspended") {
								const stopped = await lane.abort(CONTEXT);
								if (!stopped.ok && stopped.error._tag !== "NoActiveOperation") throw stopped.error;
							}
						}
					})();
					open.recovering = resuming.finally(() => { open.recovering = undefined; });
				}
			}
		}
		return open as OpenSession & { harness: Harness; lane: AgentLane };
		})();
		this.initializing.set(id, initializing);
		try {
			return await initializing;
		} finally {
			this.initializing.delete(id);
		}
	}

	private async recoverSessions(recovery: { cancelled: boolean }): Promise<void> {
		for (const row of await this.requireRepo().list({ cwd: this.root }, CONTEXT)) {
			if (recovery.cancelled) return;
			const state = await this.withSession(row.id, ({ session }) => session.getValue(laneState(MAIN), CONTEXT));
			if (recovery.cancelled) return;
			if (!state?.value.currentOperationId) continue;
			try {
				const ready = await this.ensureHarness(row.id);
				if (recovery.cancelled) ready.cancelRecovery = true;
				if (ready.cancelRecovery) {
					const stopped = await ready.lane.abort(CONTEXT);
					if (!stopped.ok && stopped.error._tag !== "NoActiveOperation") throw stopped.error;
				}
				if (ready.recovering) await ready.recovering;
				if (!recovery.cancelled) await this.notify();
			} finally {
				await this.release(row.id);
			}
		}
	}

	async prompt(id: string, text: string, options: LoomPromptOptions = {}): Promise<void> {
		if (this.closing) throw new Error("Library is closing");
		if (this.running.has(id)) await this.abort(id);
		if (this.preparing.has(id)) throw new Error(`Session is busy: ${id}`);
		let finish!: () => void;
		const preflightDone = new Promise<void>((resolve) => { finish = resolve; });
		const preparation = { cancelled: false, done: preflightDone, finish };
		this.preparing.set(id, preparation);
		let open: OpenSession & { harness: Harness; lane: AgentLane };
		try {
			open = await this.ensureHarness(id);
			if (open.recovering) await open.recovering;
			if (preparation.cancelled) return;
		} finally {
			this.preparing.delete(id);
			preparation.finish();
		}
		const lane = open.lane;
		const operationId = randomUUID();
		const emit = options.onEvent ?? (() => undefined);
		const unsubscribers: Array<() => void> = [];
		let thinkingRedacted: number | undefined;
		unsubscribers.push(open.harness.events.on("message_update", (event) => {
			if (event.lane !== MAIN || event.runId !== operationId) return;
			const update = event.event;
			if (update.type === "text_delta") emit({ type: "text", delta: update.delta });
			if (update.type !== "thinking_start" && update.type !== "thinking_delta" && update.type !== "thinking_end") return;
			const redacted = (update.partial.content[update.contentIndex] as { redacted?: boolean } | undefined)?.redacted === true;
			if (redacted || thinkingRedacted === update.contentIndex) {
				if (update.type === "thinking_start") thinkingRedacted = update.contentIndex;
				if (update.type === "thinking_end") thinkingRedacted = undefined;
				return;
			}
			if (update.type === "thinking_start") emit({ type: "thinking_start" });
			else if (update.type === "thinking_delta") emit({ type: "thinking_delta", delta: update.delta });
			else emit({ type: "thinking_end" });
		}));
		unsubscribers.push(open.harness.events.on("compaction_start", (event) => {
			if (event.lane === MAIN && event.runId === operationId) emit({ type: "compaction_start", reason: event.reason });
		}));
		unsubscribers.push(open.harness.events.on("compaction_end", (event) => {
			if (event.lane !== MAIN || event.runId !== operationId) return;
			emit({ type: "compaction_end", reason: event.reason, status: event.status });
		}));
		unsubscribers.push(open.harness.events.on("tool_start", (event) => {
			if (event.lane === MAIN && event.runId === operationId) emit({ type: "tool_start", toolCallId: event.toolCallId, name: event.toolName, args: event.args });
		}));
		unsubscribers.push(open.harness.events.on("tool_end", (event) => {
			if (event.lane !== MAIN || event.runId !== operationId) return;
			const content = event.result.content;
			const text = Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : String(content ?? "");
			emit({ type: "tool_end", toolCallId: event.toolCallId, name: event.toolName, result: { content: text, details: event.result.details }, isError: event.isError });
		}));
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => { resolveDone = resolve; });
		const run: ActiveRun = { lane, operationId, done };
		this.running.set(id, run);
		try {
			const message: AgentMessage = {
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
				...(options.attachments?.length ? { attachments: options.attachments } : {}),
			} as AgentMessage;
			const accepted = await lane.accept({ kind: "prompt", operationId, prompt: message }, CONTEXT);
			if (!accepted.ok) throw accepted.error;
			emit({ type: "agent_start" });
			if (run.cancelRequested) {
				const cancelled = await lane.abort(CONTEXT);
				if (!cancelled.ok && cancelled.error._tag !== "NoActiveOperation") throw cancelled.error;
				return;
			}
			const outcome = await lane.drive({ operationId, waitForRetry: true }, CONTEXT);
			if (!outcome.ok) throw outcome.error;
			if (outcome.value.kind === "waiting") {
				const stopped = await lane.abort(CONTEXT);
				if (!stopped.ok && stopped.error._tag !== "NoActiveOperation") throw stopped.error;
				throw new Error(`Chat run is waiting for unsupported ${outcome.value.reason}`);
			}
			if (outcome.value.outcome.status === "failed") throw new Error(outcome.value.outcome.error?.message ?? "Chat request failed");
			emit({ type: "agent_end" });
		} finally {
			for (const unsubscribe of unsubscribers) unsubscribe();
			try {
				if (run.reason === "user") await lane.appendCustomEntry("loom_user_stop", undefined, CONTEXT);
			} finally {
				if (this.running.get(id) === run) this.running.delete(id);
				resolveDone();
				await this.notify();
			}
		}
	}

	async abort(id: string, reason?: "user"): Promise<void> {
		const preparation = this.preparing.get(id);
		if (preparation) preparation.cancelled = true;
		const pending = this.handles.get(id);
		if (pending?.recovering) {
			pending.cancelRecovery = true;
			if (pending.lane) {
				const stopped = await pending.lane.abort(CONTEXT);
				if (!stopped.ok && stopped.error._tag !== "NoActiveOperation") throw stopped.error;
			}
		}
		if (preparation) await preparation.done;
		const run = this.running.get(id);
		if (!run) {
			const open = this.handles.get(id);
			if (open?.recovering) {
				open.cancelRecovery = true;
				if (open.lane) {
					const stopped = await open.lane.abort(CONTEXT);
					if (!stopped.ok && stopped.error._tag !== "NoActiveOperation") throw stopped.error;
				}
				await open.recovering;
			}
			return;
		}
		if (reason) run.reason = reason;
		run.cancelRequested = true;
		const result = await run.lane.abort(CONTEXT);
		if (!result.ok && result.error._tag !== "NoActiveOperation") throw result.error;
		await run.done;
	}

	private async cancelPreparations(): Promise<void> {
		const preparing = [...this.preparing.values()];
		for (const run of preparing) run.cancelled = true;
		await Promise.all(preparing.map((run) => run.done));
	}

	setTools(tools: LoomTool[]): Promise<void> {
		return this.serializeTransition(async () => {
			if (!this.recovery) await this.cancelPreparations();
			this.options.tools = [...tools];
			for (const [id, open] of this.handles) {
				if (!open.harness || !open.lane) continue;
				if (!open.recovering) await this.abort(id);
				const all = [...this.workspace!.tools, ...tools.map(toHarnessTool)];
				await open.harness.setTools(all, CONTEXT);
				await open.lane.setActiveTools(all.map((tool) => tool.name), CONTEXT);
			}
			this.deferredRecovery = false;
			if (this.repo && !this.recovery) this.startRecovery();
		});
	}

	setChat(chat: LoomChatEndpoint | undefined): Promise<void> {
		return this.serializeTransition(async () => {
			for (const preparation of this.preparing.values()) preparation.cancelled = true;
			await this.stopRecovery();
			await this.cancelPreparations();
			this.options.chat = chat;
			for (const id of [...this.handles.keys()]) {
				await this.abort(id);
				await this.release(id);
			}
			if (this.repo && !this.deferredRecovery && chatEndpointReady(chat)) this.startRecovery();
		});
	}

	setSystemPrompt(systemPrompt: string): void {
		this.options.systemPrompt = systemPrompt;
	}

	private async closeLibrary(): Promise<void> {
		this.closing = true;
		try {
			for (const preparation of this.preparing.values()) preparation.cancelled = true;
			await this.stopRecovery();
			await this.cancelPreparations();
			await Promise.allSettled([...this.creating]);
			for (const id of [...this.handles.keys()]) {
				await this.abort(id);
				await this.release(id);
			}
			await this.repo?.close(CONTEXT);
			this.repo = undefined;
			this.root = undefined;
			this.workspace = undefined;
		} finally {
			this.closing = false;
		}
	}

	close(): Promise<void> {
		return this.serializeTransition(() => this.closeLibrary());
	}
}

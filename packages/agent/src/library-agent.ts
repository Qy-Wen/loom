import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
	configure,
	createRegistry,
	Harness,
	NodeExecutionEnv,
	openNodeSqliteStorage,
	type AgentChange,
	type Conversation,
	type Extension,
	type HarnessOptions,
	type Registry,
} from "./durable-adapter.ts";
import { initializeConversationMetadata, LoomConversationDoc } from "./conversation-metadata.ts";

/** Storage identity is the library directory, not cwd or the currently selected conversation. */
const openLibraries = new Set<string>();

export type LibraryAgentOptions = {
	models: Models;
	/** Default true; hosts may delay recovery until approval/resources are initialized. */
	resume?: boolean;
	/** Installed before recovery starts. The owner always creates its own built-in registry. */
	extensions?: readonly Extension[];
	/** Defaults for newly created independent conversations; persisted choices survive reopen. */
	agent?: AgentChange;
	settings?: HarnessOptions["settings"];
	env?: HarnessOptions["env"];
	onReport?: HarnessOptions["onReport"];
	/** Loom extension document initialization, composed with metadata and default agent setup. */
	conversationCreated?: HarnessOptions["conversationCreated"];
};

/** One library, one Harness and Registry. Task scheduling/recovery belongs to durable, not this owner. */
export class LibraryAgent {
	readonly libraryPath: string;
	readonly storagePath: string;
	readonly harness: Harness;
	readonly registry: Registry;

	private constructor(libraryPath: string, harness: Harness, registry: Registry) {
		this.libraryPath = libraryPath;
		this.storagePath = join(libraryPath, ".loom", "loom.sqlite");
		this.harness = harness;
		this.registry = registry;
	}

	static async open(libraryPath: string, options: LibraryAgentOptions, context: Context): Promise<LibraryAgent> {
		context.abortSignal?.throwIfAborted();
		const root = await realpath(libraryPath);
		// realpath normalizes symlinks; Windows paths are case-insensitive.
		const key = process.platform === "win32" ? root.toLowerCase() : root;
		if (openLibraries.has(key)) throw new Error(`Library agent is already open: ${root}`);
		openLibraries.add(key);
		let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
		let harness: Harness | undefined;
		try {
			const registry = createRegistry();
			for (const extension of options.extensions ?? []) registry.install(extension);
			storage = await openNodeSqliteStorage(join(root, ".loom", "loom.sqlite"));
			context.abortSignal?.throwIfAborted();
			harness = await Harness.open(storage, {
				models: options.models,
				registry,
				settings: options.settings,
				env: options.env ?? (({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? root })),
				onReport: options.onReport,
				conversationCreated: async (tx, conversation) => {
					await initializeConversationMetadata(tx, conversation);
					// Owned agents inherit their owner; forks keep their as-of agent configuration.
					if (conversation.parent === undefined && conversation.owner === undefined) {
						await configure(tx, conversation.id, { cwd: root, ...options.agent });
					}
					await options.conversationCreated?.(tx, conversation);
				},
			}, context);
			// Keep the reservation until durable has closed storage, including failure-driven close.
			void harness.closed.then(() => openLibraries.delete(key));
			if (options.resume !== false) harness.resume();
			return new LibraryAgent(root, harness, registry);
		} catch (error) {
			try {
				if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
				else await storage?.close(BACKGROUND_CONTEXT);
			} finally {
				openLibraries.delete(key);
			}
			throw error;
		}
	}

	/** Independent chat; callers submit, fork, abort, and watch through its native durable handle. */
	createConversation(options: { title?: string; agent?: AgentChange }, context: Context): Promise<Conversation> {
		return this.harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: options.agent,
			init: async (tx, id) => {
				if (options.title === undefined) return;
				const metadata = await tx.doc(LoomConversationDoc, id);
				metadata.title = options.title.trim() || LoomConversationDoc.definition.initial().title;
			},
		}, context);
	}

	/** Idempotent; closes tasks and storage without withdrawing persisted unfinished work. */
	close(context: Context): Promise<void> {
		return this.harness.close(context);
	}
}

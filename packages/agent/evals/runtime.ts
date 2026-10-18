import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	BACKGROUND_CONTEXT as context, createChatExtensions, LibraryRuntime,
	createChatCustomProvider,
	type LibraryRuntimeOptions,
} from "../src/durable.ts";
import type { ChatSelection } from "../src/chat-model-config.ts";
import type { LoomTool } from "../src/types.ts";

export type EvalChatEndpoint = { baseUrl: string; apiKey?: string; model: string; contextWindow?: number };

/** Eval-only: an isolated in-memory runtime whose credentials never persist. */
export async function evalChatModels(chat: EvalChatEndpoint): Promise<{ models: Models; selection: ChatSelection }> {
	const credentials = new InMemoryCredentialStore();
	if (chat.apiKey) await credentials.modify("eval-chat", async () => ({ type: "api_key", key: chat.apiKey }));
	const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
	const provider = createChatCustomProvider({
		id: "eval-chat", kind: "custom", enabled: true, baseUrl: chat.baseUrl, api: "openai-completions",
		...(chat.apiKey ? {} : { allowUnauthenticated: true }),
		models: [{ id: chat.model, reasoning: false, input: ["text"], contextWindow: chat.contextWindow ?? 128_000, maxTokens: 8192 }],
	});
	models.setProvider(provider);
	return { models, selection: { provider: provider.id, modelId: chat.model, thinkingLevel: "off" } };
}

/** Eval fixture only: native handles, no compatibility manager or custom drive/recovery. */
export async function openEvalAgent(chat: EvalChatEndpoint, options: { systemPrompt?: string; tools?: LoomTool[]; settings?: LibraryRuntimeOptions["settings"] } = {}) {
	const library = await mkdtemp(join(tmpdir(), "loom-eval-"));
	try {
		const built = await evalChatModels(chat);
		const permission = { name: "eval.permission" };
		const assembly = await createChatExtensions(library, { systemPrompt: options.systemPrompt, tools: options.tools, permission, autoMemory: false, skills: false, workspace: { images: false } });
		const owner = await LibraryRuntime.open(library, {
			models: built.models, extensions: [assembly.extension, ...assembly.specialists, permission],
			settings: { ...options.settings, extensions: [assembly.extension] },
			agent: { model: { provider: built.selection.provider, modelId: built.selection.modelId } },
		}, context);
		return { owner, library, async close() { try { await owner.close(context); } finally { await rm(library, { recursive: true, force: true }); } } };
	} catch (error) { await rm(library, { recursive: true, force: true }); throw error; }
}
export { context };

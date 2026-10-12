import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "./durable-adapter.ts";

export const AUTO_MEMORY_CHAR_LIMIT = 2000;
const ENTRY_SEPARATOR = "\n§\n";
const writes = new Map<string, Promise<unknown>>();

export function libraryAutoMemoryFile(root: string): string {
	return join(root, ".agents", "memory", "MEMORY.md");
}

export function characterCount(text: string): number {
	return [...text].length;
}

export function parseAutoMemoryEntries(raw: string): string[] {
	const trimmed = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
	if (!trimmed) return [];
	return trimmed.split(ENTRY_SEPARATOR).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

export function serializeAutoMemory(entries: readonly string[]): string {
	return entries.join(ENTRY_SEPARATOR);
}

export function formatAutoMemoryForSystemPrompt(memory: string): string {
	const entries = parseAutoMemoryEntries(memory);
	if (entries.length === 0) return "";
	const stored = serializeAutoMemory(entries);
	return (
		`Auto memory for this library (${characterCount(stored)}/${AUTO_MEMORY_CHAR_LIMIT} characters). ` +
		"They may or may not be relevant to the current task. These are notes, not steps to perform.\n\n" +
		stored
	);
}

export async function readLibraryAutoMemory(root: string): Promise<string> {
	try {
		return await readFile(libraryAutoMemoryFile(root), "utf8");
	} catch (error) {
		if (isNotFound(error)) return "";
		throw error;
	}
}

export async function ensureLibraryAutoMemoryDir(root: string): Promise<void> {
	await mkdir(join(root, ".agents", "memory"), { recursive: true });
}

export function createAutoMemoryTool(root: string) {
	return defineTool({
		name: "auto_memory",
		description:
			"Save a durable fact about the user or this library, such as a preference or a convention. " +
			"Write facts, not procedures. Procedures belong in skills. " +
			"add appends one entry. replace and remove find one entry by a unique substring in old_text. " +
			"The result shows the notes now on disk. This session's system prompt keeps the notes from when the session started.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")]),
			content: Type.Optional(Type.String({ description: "The fact to save. Required for add and replace." })),
			old_text: Type.Optional(Type.String({ description: "A unique substring of the existing entry. Required for replace and remove." })),
		}),
		replay: "unsafe",
		async execute(args, _api, context) {
			context.abortSignal?.throwIfAborted();
			return { output: [{ type: "text", text: await updateLibraryAutoMemory(root, args, context.abortSignal) }] };
		},
	});
}

export async function updateLibraryAutoMemory(root: string, args: unknown, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const action = parseAutoMemoryArgs(args);
	return exclusive(libraryAutoMemoryFile(root), async () => {
		signal?.throwIfAborted();
		await ensureLibraryAutoMemoryDir(root);
		const current = parseAutoMemoryEntries(await readLibraryAutoMemory(root));
		const next = applyAutoMemoryAction(current, action);
		signal?.throwIfAborted();
		await writeFile(libraryAutoMemoryFile(root), serializeAutoMemory(next.entries), { encoding: "utf8", signal });
		return next.message;
	});
}

export function applyAutoMemoryAction(
	entries: readonly string[],
	action: { action: "add"; content: string } | { action: "replace"; oldText: string; content: string } | { action: "remove"; oldText: string },
): { entries: string[]; message: string } {
	if (action.action === "add") {
		if (entries.includes(action.content)) {
			return { entries: [...entries], message: liveMessage("Already saved.", entries) };
		}
		return commit([...entries, action.content], entries, "Saved.");
	}
	const index = matchEntry(entries, action.oldText);
	if (action.action === "remove") {
		const next = entries.filter((_, entryIndex) => entryIndex !== index);
		return { entries: next, message: liveMessage("Removed.", next) };
	}
	return commit(entries.map((entry, entryIndex) => (entryIndex === index ? action.content : entry)), entries, "Replaced.");
}

function commit(next: string[], previous: readonly string[], label: string): { entries: string[]; message: string } {
	const stored = serializeAutoMemory(next);
	const count = characterCount(stored);
	if (count > AUTO_MEMORY_CHAR_LIMIT) {
		const used = characterCount(serializeAutoMemory(previous));
		throw new Error(
			`Auto memory is ${used}/${AUTO_MEMORY_CHAR_LIMIT} characters. This change would be ${count}. Shorten an entry or remove one, then retry.\n\n${liveBody(previous)}`,
		);
	}
	return { entries: next, message: liveMessage(label, next) };
}

function matchEntry(entries: readonly string[], oldText: string): number {
	const hits = entries.flatMap((entry, index) => (entry.includes(oldText) ? [index] : []));
	if (hits.length === 0) throw new Error(`No entry contains that text.\n\n${liveBody(entries)}`);
	if (hits.length > 1) throw new Error(`More than one entry matches. Pass a longer unique substring.\n\n${liveBody(entries)}`);
	return hits[0] ?? 0;
}

function parseAutoMemoryArgs(args: unknown): { action: "add"; content: string } | { action: "replace"; oldText: string; content: string } | { action: "remove"; oldText: string } {
	const record = typeof args === "object" && args !== null ? args as { action?: unknown; content?: unknown; old_text?: unknown } : {};
	const content = typeof record.content === "string" ? record.content.trim() : "";
	const oldText = typeof record.old_text === "string" ? record.old_text.trim() : "";
	if (content.includes("§") || oldText.includes("§")) throw new Error("Notes cannot contain §.");
	if (record.action === "add") {
		if (!content) throw new Error("content is required.");
		return { action: "add", content };
	}
	if (record.action === "replace") {
		if (!content) throw new Error("content is required.");
		if (!oldText) throw new Error("old_text is required.");
		return { action: "replace", oldText, content };
	}
	if (record.action === "remove") {
		if (!oldText) throw new Error("old_text is required.");
		return { action: "remove", oldText };
	}
	throw new Error("action must be add, replace, or remove.");
}

function liveMessage(label: string, entries: readonly string[]): string {
	const body = liveBody(entries);
	return body ? `${label}\n\n${body}` : label;
}

function liveBody(entries: readonly string[]): string {
	if (entries.length === 0) return `Current entries (0/${AUTO_MEMORY_CHAR_LIMIT} characters):\n(none)`;
	const stored = serializeAutoMemory(entries);
	return `Current entries (${characterCount(stored)}/${AUTO_MEMORY_CHAR_LIMIT} characters):\n${stored}`;
}

function exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = writes.get(key) ?? Promise.resolve();
	const run = previous.then(operation, operation);
	writes.set(key, run);
	const cleanup = () => { if (writes.get(key) === run) writes.delete(key); };
	void run.then(cleanup, cleanup);
	return run;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

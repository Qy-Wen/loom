import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	BACKGROUND_CONTEXT as context,
	defineExtension,
	defineTask,
	LibraryAgent,
	LoomConversationDoc,
	listLoomConversations,
	setConversationArchived,
	setConversationTitle,
	section,
	withAbortSignal,
	type ConversationId,
	type Extension,
} from "@loom/agent/durable";

async function temporary(run: (path: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "loom-library-agent-"));
	try { await run(directory); }
	finally { await rm(directory, { recursive: true, force: true }); }
}

const options = () => ({ models: createModels() });

test("library owner creates, lists, renames, archives, and reopens committed metadata", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		const legacy = join(path, ".loom", "harness-sessions");
		await mkdir(legacy, { recursive: true });
		await writeFile(join(legacy, "ignored.jsonl"), "invalid legacy session\n");
		let owner = await LibraryAgent.open(path, options(), context);
		try {
			assert.equal(owner.storagePath, join(owner.libraryPath, ".loom", "loom.sqlite"));
			assert.deepEqual(await listLoomConversations(owner.harness, {}, context), []);
			const first = await owner.createConversation({}, context);
			const second = await owner.createConversation({ title: " Second " }, context);
			assert.equal((await first.agent(context)).cwd, owner.libraryPath);
			assert.deepEqual((await listLoomConversations(owner.harness, {}, context)).map((row) => row.title), ["Second", "New session"]);
			await setConversationTitle(owner.harness, first.id, " Project ", context);
			await setConversationArchived(owner.harness, first.id, true, context);
			assert.deepEqual((await listLoomConversations(owner.harness, { archived: false }, context)).map((row) => row.id), [second.id]);
			assert.deepEqual((await listLoomConversations(owner.harness, { archived: true }, context)).map((row) => row.title), ["Project"]);
			assert.deepEqual((await first.entries({}, 10, undefined, context)).items, []);
			assert.deepEqual((await first.context(context)).messages, []); // Metadata is not a model message.
			await owner.close(context);
			owner = await LibraryAgent.open(path, options(), context);
			assert.equal((await owner.harness.conversation(first.id, context))?.id, first.id);
			assert.deepEqual(await owner.harness.snapshot(LoomConversationDoc, first.id, context), { title: "Project", archived: true, hidden: false, createdAt: (await owner.harness.snapshot(LoomConversationDoc, first.id, context))!.createdAt });
			await setConversationArchived(owner.harness, first.id, false, context);
			await setConversationTitle(owner.harness, first.id, " ", context);
			assert.equal((await listLoomConversations(owner.harness, { archived: false }, context)).length, 2);
			assert.equal((await owner.harness.snapshot(LoomConversationDoc, first.id, context))?.title, "New session");
			assert.equal(await readFile(join(legacy, "ignored.jsonl"), "utf8"), "invalid legacy session\n");
		} finally { await owner.close(context); }
	});
});

test("native and raw forks add a branch suffix, reset archive, and retain source history", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		let owner = await LibraryAgent.open(path, { ...options(), agent: { instructions: "initial" } }, context);
		try {
			const parent = await owner.createConversation({ title: "素材整理" }, context);
			const entry = await parent.commit((tx) => tx.appendEntry(parent.id, {
				kind: "test.note", model: [{ role: "user", content: "history", timestamp: 1 }],
			}), context);
			await parent.configure({ instructions: "newer" }, context);
			await setConversationTitle(owner.harness, parent.id, "素材整理新标题", context);
			await setConversationArchived(owner.harness, parent.id, true, context);
			const fork = await parent.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
			assert.equal((await owner.harness.snapshot(LoomConversationDoc, fork.id, context))?.archived, false);
			assert.equal((await owner.harness.snapshot(LoomConversationDoc, fork.id, context))?.title, "素材整理新标题（分支）");
			assert.equal((await fork.agent(context)).instructions, "initial"); // Agent uses as-of; title uses current.
			assert.deepEqual((await fork.context(context)).messages, (await parent.context(context)).messages);
			const nested = await fork.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
			assert.equal((await owner.harness.snapshot(LoomConversationDoc, nested.id, context))?.title, "素材整理新标题（分支）（分支）");
			const raw = await owner.harness.commit((tx) => tx.forkConversation(parent.id, entry.id, { ownership: { kind: "ownerless" } }), context);
			assert.equal((await owner.harness.snapshot(LoomConversationDoc, raw.id, context))?.title, "素材整理新标题（分支）");
			assert.equal((await owner.harness.snapshot(LoomConversationDoc, parent.id, context))?.title, "素材整理新标题");
			assert.equal((await owner.harness.snapshot(LoomConversationDoc, parent.id, context))?.archived, true);
			assert.equal((await parent.entries({}, 10, undefined, context)).items.length, 1);
			await owner.close(context);
			owner = await LibraryAgent.open(path, options(), context);
			assert.equal((await owner.harness.snapshot(LoomConversationDoc, fork.id, context))?.title, "素材整理新标题（分支）");
			assert.equal((await (await owner.harness.conversation(fork.id, context))!.context(context)).messages.length, 1);
		} finally { await owner.close(context); }
	});
});

test("metadata is watchable, raw creation initializes it, and unknown IDs do not create phantom docs", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		const owner = await LibraryAgent.open(path, options(), context);
		try {
			const raw = await owner.harness.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
			const watch = await owner.harness.watchDoc(LoomConversationDoc, raw.id, context);
			assert.ok(watch);
			assert.equal(watch.value?.title, "New session");
			const changed = Promise.withResolvers<string>();
			watch.start(async (value) => { changed.resolve(value!.title); });
			try {
				await setConversationTitle(owner.harness, raw.id, "Watched", context);
				assert.equal(await changed.promise, "Watched");
			} finally { await watch.stop(); }
			const missing = 999_999 as ConversationId;
			await assert.rejects(setConversationTitle(owner.harness, missing, "ghost", context), /Unknown conversation/);
			await assert.rejects(setConversationArchived(owner.harness, missing, true, context), /Unknown conversation/);
			assert.equal((await listLoomConversations(owner.harness, {}, context)).length, 1);
		} finally { await owner.close(context); }
	});
});

test("owned conversations have metadata but stay out of the main list", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		const owner = await LibraryAgent.open(path, options(), context);
		try {
			const parent = await owner.createConversation({}, context);
			const task = await parent.commit((tx) => tx.createTask(defineTask<null, { phase: "run" }, null>({
				name: "test.uninstalled", version: 1, initial: () => ({ phase: "run" }),
				phases: { run: async () => {} }, abort: async () => {},
			}), null, { ownership: { kind: "conversation" } }), context);
			const child = await owner.harness.createConversation({ ownership: { kind: "task", taskId: task } }, context);
			assert.equal((await child.agent(context)).cwd, owner.libraryPath);
			assert.equal((await owner.harness.snapshot(LoomConversationDoc, child.id, context))?.title, "New session");
			assert.deepEqual((await listLoomConversations(owner.harness, {}, context)).map((row) => row.id), [parent.id]);
			assert.equal((await listLoomConversations(owner.harness, { includeOwned: true }, context)).length, 2);
		} finally { await owner.close(context); }
	});
});

test("one process cannot open the same library twice, including canonical path aliases", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		const root = join(path, "library");
		const alias = join(path, "alias");
		await mkdir(root);
		await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
		const owners = await Promise.allSettled([LibraryAgent.open(root, options(), context), LibraryAgent.open(alias, options(), context)]);
		const successes = owners.filter((result) => result.status === "fulfilled");
		assert.equal(successes.length, 1);
		const owner = successes[0]!.value;
		try {
			await assert.rejects(LibraryAgent.open(root, options(), context), /already open/);
		} finally { await Promise.all([owner.close(context), owner.close(context)]); }
		const reopened = await LibraryAgent.open(alias, options(), context);
		await reopened.close(context);
	});
});

test("failed or cancelled open releases its library reservation; libraries remain isolated", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		const first = join(path, "first");
		const second = join(path, "second");
		await mkdir(first);
		await mkdir(second);
		const broken = { ...options(), extensions: [{ name: "broken", get tasks(): Extension["tasks"] { throw new Error("bad extension"); } }] };
		await assert.rejects(LibraryAgent.open(first, broken, context), /bad extension/);
		await assert.rejects(LibraryAgent.open(first, options(), withAbortSignal(AbortSignal.abort(), context)));
		const a = await LibraryAgent.open(first, options(), context);
		const b = await LibraryAgent.open(second, options(), context);
		try {
			await a.createConversation({ title: "only first" }, context);
			assert.deepEqual(await listLoomConversations(b.harness, {}, context), []);
			await a.harness.close(context); // Direct durable close also releases ownership.
			const again = await LibraryAgent.open(first, options(), context);
			await again.close(context);
		} finally { await a.close(context); await b.close(context); }
	});
});

test("registry hot replacement applies without reopening the library", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		const owner = await LibraryAgent.open(path, options(), context);
		try {
			const conversation = await owner.createConversation({}, context);
			const one = defineExtension({ name: "prompt", sections: [section("preamble", () => "one")] });
			owner.registry.install(one);
			assert.equal((await conversation.agent(context)).extensions.at(-1)?.name, "prompt");
			const two = defineExtension({ name: "prompt", sections: [section("preamble", () => "two")] });
			owner.registry.install(two);
			assert.equal((await conversation.agent(context)).extensions.at(-1), two);
			owner.registry.uninstall(two);
			assert.equal((await conversation.agent(context)).extensions.some((extension) => extension.name === "prompt"), false);
		} finally { await owner.close(context); }
	});
});

test("conversation listing reads every page in newest-first order", { timeout: 15_000 }, async () => {
	await temporary(async (path) => {
		const owner = await LibraryAgent.open(path, options(), context);
		try {
			for (let index = 0; index < 260; index++) await owner.createConversation({ title: `chat-${index}` }, context);
			const rows = await listLoomConversations(owner.harness, {}, context);
			assert.equal(rows.length, 260);
			assert.equal(rows[0]?.title, "chat-259");
			assert.equal(rows.at(-1)?.title, "chat-0");
		} finally { await owner.close(context); }
	});
});

test("owner installs model defaults for new chats without replacing persisted agent choices", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const agent = { model: { provider: faux.models[0].provider, modelId: faux.models[0].id }, instructions: "default" };
		let owner = await LibraryAgent.open(path, { models, agent }, context);
		try {
			const conversation = await owner.createConversation({ agent: { instructions: "custom" } }, context);
			faux.setResponses([fauxAssistantMessage("answer")]);
			assert.equal((await (await conversation.submit({ type: "input", content: "hi" }, context)).wait(context)).status, "done");
			await owner.close(context);
			owner = await LibraryAgent.open(path, { models, agent: { ...agent, instructions: "new default" } }, context);
			const reopened = await owner.harness.conversation(conversation.id, context);
			assert.equal((await reopened!.agent(context)).instructions, "custom");
			const fresh = await owner.createConversation({}, context);
			assert.equal((await fresh.agent(context)).instructions, "new default");
		} finally { await owner.close(context); }
	});
});

test("close leaves unfinished work persisted and reopen delegates recovery to durable", { timeout: 10_000 }, async () => {
	await temporary(async (path) => {
		const entered = Promise.withResolvers<void>();
		let recovering = false;
		let runs = 0;
		const Work = defineTask<null, { phase: "run" }, string>({
			name: "test.resume", version: 1, initial: () => ({ phase: "run" }),
			phases: { run: async (_task, runtime, callContext) => {
				runs++;
				entered.resolve();
				if (!recovering) {
					await new Promise<void>((resolve) => runtime.signal.addEventListener("abort", () => resolve(), { once: true }));
					return;
				}
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "recovered" } }), callContext);
			} },
			abort: async (_task, runtime, callContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext);
			},
		});
		const settings = { ...options(), extensions: [defineExtension({ name: "work", tasks: [Work] })] };
		let owner = await LibraryAgent.open(path, settings, context);
		try {
			const conversation = await owner.createConversation({}, context);
			const id = await conversation.commit((tx) => tx.createTask(Work, null, { ownership: { kind: "conversation" } }), context);
			await entered.promise;
			await owner.close(context);
			recovering = true;
			owner = await LibraryAgent.open(path, settings, context);
			const done = await owner.harness.waitForTask(id, context);
			assert.deepEqual(done.state.outcome, { status: "completed", result: "recovered" });
			assert.equal(runs, 2);
		} finally { await owner.close(context); }
	});
});

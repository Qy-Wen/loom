import { Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context, createModels, LibraryAgent, DurableTrace, TraceStore, defineExtension, defineTool } from "../../src/durable.ts";

const root = process.argv[2]!;
const mode = process.argv[3]!;
const trace = new DurableTrace(await TraceStore.open(root), (record) => {
	if (mode === "stream" && record.spans.some((span) => String(span.attributes["loom.io.output"]).includes("crash partial"))) process.send?.({ ready: true });
});
const faux = fauxProvider({ tokensPerSecond: 20 });
const models = createModels(); models.setProvider(faux.provider);
const tool = defineTool({ name: "effect", description: "effect", parameters: Type.Object({}), replay: "unsafe", execute: async () => {
	trace.flush(); process.send?.({ ready: true });
	await new Promise(() => {});
	return { output: [] };
} });
const owner = await LibraryAgent.open(root, { models: trace.models(models), resume: false, extensions: [trace.extension, defineExtension({ name: "test", tools: [tool] })], agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } } }, context);
await trace.start(owner.harness);
faux.setResponses([mode === "stream" ? answer("crash partial " + "long response ".repeat(100)) : answer(fauxToolCall("effect", {}), { stopReason: "toolUse" })]);
const conversation = await owner.createConversation({}, context);
await conversation.submit({ type: "input", content: "crash question", requestId: "crash" }, context);

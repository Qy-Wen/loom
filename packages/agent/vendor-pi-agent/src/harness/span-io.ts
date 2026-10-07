import type { SpanAttributes, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { type Context, getTelemetryContext } from "./context.ts";

const MODEL_IO_LIMIT = 64 * 1024;

type TraceBlock = {
	type?: string;
	text?: string;
	thinking?: string;
	redacted?: boolean;
	name?: string;
	arguments?: unknown;
	mimeType?: string;
};

type TraceMessage = {
	role?: string;
	content?: string | readonly TraceBlock[];
	toolName?: string;
	errorMessage?: string;
};

function clip(text: string): string {
	if (text.length <= MODEL_IO_LIMIT) return text;
	return `${text.slice(0, MODEL_IO_LIMIT)}\n…`;
}

function blockText(block: TraceBlock): string {
	if (block.type === "text") return block.text ?? "";
	if (block.type === "thinking") return block.redacted ? "[redacted thinking]" : block.thinking ?? "";
	if (block.type === "toolCall") {
		let args = "";
		try {
			args = JSON.stringify(block.arguments ?? {});
		} catch {
			args = "";
		}
		return `${block.name ?? "tool"} ${args}`;
	}
	if (block.type === "image") return `[image${block.mimeType ? ` ${block.mimeType}` : ""}]`;
	return "";
}

function contentText(content: TraceMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => blockText(block)).filter((part) => part.length > 0).join("\n");
}

function messageText(message: TraceMessage): string {
	const role = message.role === "toolResult" && message.toolName ? `toolResult ${message.toolName}` : message.role ?? "message";
	const body = contentText(message.content);
	return body ? `${role}\n${body}` : role;
}

/** Transcript actually handed to the provider after context transforms. Images stay as placeholders. */
export function formatModelRequest(systemPrompt: string, messages: readonly object[]): string {
	const parts: string[] = [];
	if (systemPrompt.trim()) parts.push(`system\n${systemPrompt}`);
	for (const message of messages) parts.push(messageText(message as TraceMessage));
	return parts.join("\n\n");
}

/** Assistant text, thinking, and tool calls. Image bytes are omitted. */
export function formatAssistantReply(message: object): string {
	const reply = message as TraceMessage;
	const parts = [contentText(reply.content)];
	if (reply.errorMessage) parts.push(`error\n${reply.errorMessage}`);
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/** Attach the model request and reply to the active span. No-op without a recorder. */
export function noteSpanIO(context: Context, input: string, output: string): void {
	const telemetry = getTelemetryContext(context);
	if (!("setAttributes" in telemetry) || typeof telemetry.setAttributes !== "function") return;
	const attributes: SpanAttributes = {};
	if (input) attributes["loom.io.input"] = clip(input);
	if (output) attributes["loom.io.output"] = clip(output);
	if (Object.keys(attributes).length === 0) return;
	(telemetry as TelemetrySpan).setAttributes(attributes);
}

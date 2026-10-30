import type { LoomTraceSpan } from "@loom/agent";
import type { DevTraceRecord } from "../../shared/dev-trace.ts";
import { jsonString, parseTraceJson, type JsonValue } from "./json-values.ts";
import { spanPayload, visibleSpans } from "./trace-spans.ts";

export type EventKind = "system" | "user" | "context" | "assistant" | "tool" | "approval" | "phase";
export type TraceEvent = {
	id: string;
	kind: EventKind;
	label: string;
	summary: string;
	text?: string;
	/** The captured fragment belonging to a snapshot event, not its source span's full request. */
	rawContent?: string;
	toolList?: TraceToolList;
	record: DevTraceRecord;
	span: LoomTraceSpan;
	step: number;
	marker: boolean;
};
export type TraceTurn = { id: string; record: DevTraceRecord; events: TraceEvent[] };
export const eventLabels: Record<EventKind, string> = { system: "系统", user: "用户", context: "上下文", assistant: "助手", tool: "工具", approval: "审批", phase: "底层记录" };
export function conversationId(record: DevTraceRecord): string { return record.threadId || `trace:${record.id}`; }
export function parsedValue(text: string | undefined): JsonValue | undefined {
	if (text === undefined) return undefined;
	const parsed = parseTraceJson(text);
	return parsed.kind === "json" ? parsed.value : undefined;
}
export function objectValue(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
/** Decode only known message blocks; a string that looks like JSON remains a string. */
export function contentText(value: JsonValue | undefined, record: DevTraceRecord): string {
	if (typeof value === "string") return jsonString(value, record.blobs).text;
	if (Array.isArray(value)) return value.map((item) => contentText(item, record)).filter(Boolean).join("\n");
	const object = objectValue(value);
	if (!object) return "";
	if (object.type === "toolCall") return `${object.name ?? "tool"} ${JSON.stringify(object.arguments ?? {})}`;
	if (object.type === "image" || object.type === "image_url" || object.type === "input_image") return "[image omitted]";
	return contentText(object.text ?? object.thinking ?? object.content, record);
}
export type TraceToolList = { definitions: JsonValue[]; captured: boolean; incomplete: boolean };
/** Only recognize recorder omission markers inside tool declarations, not unrelated prompt clipping. */
function toolDefinitionOmitted(value: JsonValue | undefined, blobs?: DevTraceRecord["blobs"]): boolean {
	if (typeof value === "string") {
		const resolved = jsonString(value, blobs);
		if (resolved.missing) return true;
		return /^(?:\[omitted\]|\[unserializable\]|… \(trace content omitted\)|… \(\d+ (?:fields|items) omitted\))$/.test(resolved.text)
			|| /\n… \(\d+ (?:of \d+ )?bytes cut\)$/.test(resolved.text);
	}
	return value !== null && typeof value === "object" && Object.values(value).some((item) => toolDefinitionOmitted(item, blobs));
}
/** Prefer the independent request snapshot; replay legacy captured deltas only when it is absent. */
export function capturedTools(messages: JsonValue | undefined, snapshot?: string, blobs?: DevTraceRecord["blobs"]): TraceToolList {
	if (snapshot !== undefined) {
		const value = parsedValue(snapshot);
		if (!Array.isArray(value)) return { definitions: [], captured: true, incomplete: true };
		const definitions = value.filter((item) => typeof objectValue(item)?.name === "string");
		return { definitions, captured: true, incomplete: definitions.length !== value.length || definitions.some((item) => toolDefinitionOmitted(item, blobs)) };
	}
	const tools = new Map<string, JsonValue>();
	let captured = false, omittedAdditions = false;
	for (const value of Array.isArray(messages) ? messages : []) {
		const message = objectValue(value);
		if (message?.role !== "system") continue;
		for (const key of ["toolsRemoved", "toolsAdded"] as const) {
			if (!Object.hasOwn(message, key)) continue;
			captured = true;
			const changes = message[key];
			if (!Array.isArray(changes)) {
				if (key === "toolsAdded" && toolDefinitionOmitted(changes, blobs)) omittedAdditions = true;
				continue;
			}
			for (const change of changes) {
				const tool = objectValue(change);
				if (!tool || typeof tool.name !== "string") {
					if (key === "toolsAdded" && toolDefinitionOmitted(change, blobs)) omittedAdditions = true;
					continue;
				}
				if (key === "toolsRemoved") tools.delete(tool.name);
				else tools.set(tool.name, tool);
			}
		}
	}
	const definitions = [...tools.values()];
	return { definitions, captured, incomplete: omittedAdditions || definitions.some((item) => toolDefinitionOmitted(item, blobs)) };
}
export function shortText(text: string, limit = 220): string { return text.replace(/\s+/g, " ").trim().slice(0, limit); }
export function eventStatus(event: TraceEvent): string {
	const { span } = event;
	if (span.interrupted) return "interrupted";
	if (span.status.status === "error" || span.attributes["loom.tool.is_error"] === true) return "error";
	if (event.kind === "user") return event.record.status;
	return span.endedMs === undefined ? "running" : "completed";
}

/** Routine scheduling outcomes (waiting, sleeping, done, next=…) are not separate user-facing actions. */
export function phaseDiagnostic(span: LoomTraceSpan): { label: string; summary: string } | undefined {
	const task = String(span.attributes["task.name"] ?? "");
	const phase = String(span.attributes.phase ?? "");
	const attempt = Number(span.attributes.attempt);
	const compaction = task === "pi.compaction";
	const generation = task === "pi.generation" || task === "pi.generate";
	const subject = compaction ? "上下文压缩" : generation ? "模型请求" : "任务执行";
	if (span.interrupted) return { label: "中断", summary: `${subject}已中断` };
	if (span.status.status === "error") {
		const error = span.status.error?.message;
		return { label: "异常", summary: `${subject}失败${error ? ` · ${shortText(error, 160)}` : ""}` };
	}
	if (span.attributes.outcome === "aborted") return { label: "中断", summary: `${subject}已取消` };
	if (phase === "retry") return { label: "重试", summary: `${subject}等待重试` };
	// Show the start of a new attempt once, not its normal request/tools scheduling phases again.
	if (attempt > 1 && (phase === "prepare" || phase === "select")) return { label: "重试", summary: `${subject}重试 · 第 ${attempt} 次` };
	if (compaction) return { label: "压缩", summary: phase === "select" ? "准备上下文压缩" : "上下文压缩" };
	return undefined;
}

/** Presentation projection only. Native span identities, lifetimes and stored records are unchanged. */
export function traceTurns(records: readonly DevTraceRecord[]): TraceTurn[] {
	return [...records].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).map((record, turnIndex) => {
		const spans = visibleSpans(record.spans).sort((a, b) => a.startedMs - b.startedMs);
		const firstRequest = spans.find((span) => span.name === "pi.ai.request");
		const source = firstRequest ?? spans[0];
		const messages = parsedValue(source ? spanPayload(source)?.input : undefined);
		const rows = Array.isArray(messages) ? messages.map(objectValue).filter((row) => row !== undefined) : [];
		const submission = spans.find((span) => span.name === "pi.durable.submit");
		const events: TraceEvent[] = [];
		const add = (span: LoomTraceSpan, kind: EventKind, summary: string, text?: string, marker = false, rawValue?: JsonValue) => {
			events.push({ id: `${record.id}/${span.id}/${kind}`, kind, label: kind === "phase" ? phaseDiagnostic(span)?.label ?? eventLabels.phase : eventLabels[kind], summary, text, rawContent: rawValue === undefined ? undefined : JSON.stringify(rawValue), marker, record, span, step: marker ? 0 : events.filter((event) => !event.marker).length + 1 });
		};
		if (firstRequest && turnIndex === 0) {
			const system = rows.find((row) => row.role === "system");
			const value = objectValue(system?.sections)?.preamble ?? system?.content;
			const text = contentText(value, record);
			const snapshot = firstRequest.attributes["loom.io.tools"];
			const toolList = capturedTools(messages, typeof snapshot === "string" ? snapshot : undefined, record.blobs);
			if (text || toolList.captured || (system && toolList.incomplete)) {
				add(firstRequest, "system", "系统提示词", text || undefined, true, value);
				events.at(-1)!.toolList = toolList;
			}
		}
		if (firstRequest || submission?.attributes["submission.type"] === "input") {
			const user = rows.findLast((row) => row.role === "user");
			const text = contentText(user?.content, record);
			add(submission ?? firstRequest!, "user", text ? shortText(text) : "输入内容未采集或历史 JSON 已截断", text || undefined, true, user?.content);
		}
		if (firstRequest) {
			const system = rows.find((row) => row.role === "system");
			const value = objectValue(system?.sections)?.instructions;
			const instructions = contentText(value, record);
			if (instructions && !/^<instructions>\s*<\/instructions>$/.test(instructions)) add(firstRequest, "context", shortText(instructions), instructions, true, value);
		}
		for (const span of spans) {
			if (span.name === "pi.durable.submit") continue;
			const payload = spanPayload(span);
			if (span.name === "pi.ai.request" || span.name === "pi.ai.poll") {
				const output = contentText(parsedValue(payload?.output) ?? payload?.output, record);
				add(span, "assistant", `${span.name === "pi.ai.poll" ? "轮询 · " : ""}${shortText(output) || (span.endedMs === undefined ? "等待模型输出…" : "无已采集输出")}`);
			} else if (span.name === "loom.approval") {
				add(span, "approval", `工具审批 · ${span.attributes["tool.name"] ?? "tool"}`);
			} else if (span.name === "pi.durable.phase" && span.attributes["task.name"] === "pi.tool") {
				const args = payload?.input ?? "";
				const result = contentText(parsedValue(payload?.output) ?? payload?.output, record) || payload?.output || "";
				add(span, "tool", `${span.attributes["tool.name"] ?? "tool"} ${shortText(args, 120)}${result ? ` → ${shortText(result, 160)}` : ""}`);
			} else {
				const diagnostic = phaseDiagnostic(span);
				if (diagnostic) add(span, "phase", diagnostic.summary);
			}
		}
		return { id: record.id, record, events };
	});
}

export function eventForSpan(turns: readonly TraceTurn[], spanId: string): TraceEvent | undefined {
	const events = turns.flatMap((turn) => turn.events);
	return events.find((event) => event.span.id === spanId && !event.marker) ?? events.find((event) => event.span.id === spanId);
}
export type TimelineBlock = { event: TraceEvent; left: number; width: number; lane: number; firstChunk?: number };
export function timelineBlocks(events: readonly TraceEvent[], actual: boolean, now: number): TimelineBlock[] {
	if (!events.length) return [];
	const start = Math.min(...events.map((event) => event.span.startedMs));
	const end = Math.max(...events.map((event) => event.marker ? event.span.startedMs : event.span.endedMs ?? now));
	const range = Math.max(1, end - start);
	return events.map((event, index) => {
		const duration = event.marker ? 0 : Math.max(0, (event.span.endedMs ?? now) - event.span.startedMs);
		const first = event.span.events.find((row) => row.name === "pi.ai.first_chunk")?.timeMs;
		return { event, lane: event.kind === "assistant" ? 1 : ["tool", "approval", "phase"].includes(event.kind) ? 2 : 0,
			left: actual ? (event.span.startedMs - start) / range : index / events.length,
			width: actual ? duration / range : 1 / events.length,
			firstChunk: event.kind === "assistant" && typeof first === "number" && duration > 0 ? Math.min(1, Math.max(0, first / duration)) : undefined };
	});
}

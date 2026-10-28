import type { AgentEvent } from "../src/durable.ts";
import type { AgentEvalTask } from "./tasks.ts";

export type AgentCall = { name: string; args: unknown };

export type AgentScore = {
	id: string;
	ok: boolean;
	missingTools: string[];
	forbiddenHits: string[];
	argMisses: string[];
	answerMisses: string[];
	/** Set when the first search was not the one the task requires. */
	wrongFirstSearch?: string;
	calls: AgentCall[];
	/** Set when the task did not finish (timeout, rejected input); the task counts as failed. */
	error?: string;
};

export function callsFromEvents(events: AgentEvent[]): AgentCall[] {
	return events.flatMap((event) => event.type === "tool_execution_start" ? [{ name: event.toolName, args: event.args }] : []);
}

export function answerFromEvents(events: AgentEvent[]): string {
	return events.flatMap((event) => event.type === "message_end" ? event.entry.model ?? [] : [])
		.filter((message) => message.role === "assistant")
		.flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => part.text)).join("");
}

export function scoreAgentTask(task: AgentEvalTask, calls: AgentCall[], answer: string): AgentScore {
	const names = calls.map((call) => call.name);
	const missingTools = task.expectTools.filter((name) => !names.includes(name));
	const forbiddenHits = task.forbidTools.filter((name) => names.includes(name));
	const argMisses: string[] = [];
	for (const [tool, fields] of Object.entries(task.argIncludes ?? {})) {
		const call = calls.find((candidate) => candidate.name === tool);
		if (!call) {
			argMisses.push(`${tool} (missing call)`);
			continue;
		}
		const args = asRecord(call.args);
		for (const [field, pattern] of Object.entries(fields)) {
			const value = args[field];
			const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
			if (!new RegExp(pattern, "i").test(text)) argMisses.push(`${tool}.${field}`);
		}
	}
	const answerMisses = (task.answerIncludes ?? []).filter((needle) => !answer.includes(needle));
	const firstSearch = names.find((name) => name === "search_assets" || name === "deep_search_assets");
	const wrongFirstSearch = task.firstSearch && firstSearch && firstSearch !== task.firstSearch ? `${firstSearch} first, wanted ${task.firstSearch}` : undefined;
	return {
		id: task.id,
		ok: missingTools.length === 0 && forbiddenHits.length === 0 && argMisses.length === 0 && answerMisses.length === 0 && !wrongFirstSearch,
		missingTools,
		forbiddenHits,
		argMisses,
		answerMisses,
		...(wrongFirstSearch ? { wrongFirstSearch } : {}),
		calls,
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
	return {};
}

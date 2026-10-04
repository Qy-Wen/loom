import type { LoomAgentEvent } from "../src/types.ts";
import type { AgentEvalTask } from "./tasks.ts";

export type AgentCall = { name: string; args: unknown };

export type AgentScore = {
	id: string;
	ok: boolean;
	missingTools: string[];
	forbiddenHits: string[];
	argMisses: string[];
	answerMisses: string[];
	calls: AgentCall[];
};

export function callsFromEvents(events: LoomAgentEvent[]): AgentCall[] {
	return events
		.filter((event): event is Extract<LoomAgentEvent, { type: "tool_start" }> => event.type === "tool_start")
		.map((event) => ({ name: event.name, args: event.args }));
}

export function answerFromEvents(events: LoomAgentEvent[]): string {
	return events
		.filter((event): event is Extract<LoomAgentEvent, { type: "text" }> => event.type === "text")
		.map((event) => event.delta)
		.join("");
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
	return {
		id: task.id,
		ok: missingTools.length === 0 && forbiddenHits.length === 0 && argMisses.length === 0 && answerMisses.length === 0,
		missingTools,
		forbiddenHits,
		argMisses,
		answerMisses,
		calls,
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
	return {};
}

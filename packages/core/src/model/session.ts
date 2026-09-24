export type SessionStatus = "open" | "archived";

/** Opaque, JSON-serializable Agent message (user / assistant / toolResult). */
export type LoomTranscriptMessage = Record<string, unknown> & { role: string };

export interface SessionSummary {
	id: string;
	title: string;
	status: SessionStatus;
	createdAt: number;
	updatedAt: number;
}

export interface SessionRecord extends SessionSummary {
	messages: LoomTranscriptMessage[];
}

export const DEFAULT_SESSION_TITLE = "New session";

export function isTranscriptMessage(value: unknown): value is LoomTranscriptMessage {
	return typeof value === "object" && value !== null && typeof (value as { role?: unknown }).role === "string";
}

export function userMessageText(message: LoomTranscriptMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
	if (!Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter((part): part is { type?: string; text?: string } => typeof part === "object" && part !== null)
		.map((part) => part.text ?? "")
		.join("")
		.trim();
	return text || undefined;
}

export function titleFromUserText(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return (compact.slice(0, 42) + (compact.length > 42 ? "…" : "")) || DEFAULT_SESSION_TITLE;
}

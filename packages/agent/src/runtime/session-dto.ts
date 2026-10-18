/** Plain IPC records, not live durable handles. IDs are decimal strings at the process boundary. */
export interface LoomSessionSummary {
	id: string;
	title: string;
	status: "open" | "archived";
	createdAt: number;
	updatedAt: number;
}
/** Approximate active context size: provider usage when applicable, plus estimates of trailing messages. */
export interface LoomContextUsage { tokens: number | null; window: number; percent: number | null }
/** The conversation's persisted model/thinking selection; effective from the next request. */
export interface LoomSessionModel {
	provider: string;
	modelId: string;
	thinkingLevel?: string;
}
export interface LoomSessionRecord extends LoomSessionSummary {
	messages: Array<Record<string, unknown> & { role: string }>;
	context: LoomContextUsage | undefined;
	model: LoomSessionModel | undefined;
}

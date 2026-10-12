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
export interface LoomSessionRecord extends LoomSessionSummary {
	messages: Array<Record<string, unknown> & { role: string }>;
	context: LoomContextUsage | undefined;
}

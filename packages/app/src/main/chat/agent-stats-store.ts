import { JsonFile } from "../storage/file.ts";
import {
	addUsage,
	emptyUsageTotals,
	statsView,
	type AgentStatsView,
	type AgentUsageTotals,
} from "../../shared/agent-stats.ts";

export function parseUsageTotals(value: unknown): AgentUsageTotals {
	if (!value || typeof value !== "object") return emptyUsageTotals();
	const row = value as Partial<AgentUsageTotals>;
	const number = (key: keyof AgentUsageTotals): number => {
		const item = row[key];
		return typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : 0;
	};
	return {
		turns: number("turns"),
		input: number("input"),
		output: number("output"),
		cacheRead: number("cacheRead"),
		cacheWrite: number("cacheWrite"),
	};
}

export class AgentStatsStore {
	private readonly file: JsonFile<AgentUsageTotals>;
	private totals = emptyUsageTotals();
	private loaded = false;

	constructor(filePath: string) {
		this.file = new JsonFile(filePath, parseUsageTotals, { recoverCorrupt: true });
	}

	async load(): Promise<AgentUsageTotals> {
		if (this.loaded) return this.totals;
		this.totals = (await this.file.read()) ?? emptyUsageTotals();
		this.loaded = true;
		return this.totals;
	}

	async view(): Promise<AgentStatsView> {
		return statsView(await this.load());
	}

	async record(usage: Omit<AgentUsageTotals, "turns">): Promise<AgentStatsView> {
		await this.load();
		this.totals = addUsage(this.totals, usage);
		await this.flush();
		return statsView(this.totals);
	}

	async reset(): Promise<AgentStatsView> {
		this.totals = emptyUsageTotals();
		this.loaded = true;
		await this.flush();
		return statsView(this.totals);
	}

	private async flush(): Promise<void> {
		const value = this.totals;
		await this.file.update(async () => ({ value, result: undefined }));
	}
}

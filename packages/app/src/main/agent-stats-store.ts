import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	addUsage,
	emptyUsageTotals,
	statsView,
	type AgentStatsView,
	type AgentUsageTotals,
} from "../shared/agent-stats.ts";

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
	private readonly filePath: string;
	private totals = emptyUsageTotals();
	private loaded = false;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async load(): Promise<AgentUsageTotals> {
		if (this.loaded) return this.totals;
		try {
			this.totals = parseUsageTotals(JSON.parse(await readFile(this.filePath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.totals = emptyUsageTotals();
		}
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
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, `${JSON.stringify(this.totals, null, "\t")}\n`, "utf8");
	}
}

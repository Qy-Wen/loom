import type { LoomAssetType } from "../src/context/attachments.ts";

export type AgentEvalTask = {
	id: string;
	user: string;
	selection?: { assetId: string; path: string; assetType: LoomAssetType };
	chips?: Array<{ assetId: string; path: string; assetType: LoomAssetType }>;
	expectTools: string[];
	forbidTools: string[];
	/** Per tool name, each field is a regex against String(args[field]). */
	argIncludes?: Record<string, Record<string, string>>;
	answerIncludes?: string[];
	/** The first search the Agent runs (search_assets or deep_search_assets) must be this one. */
	firstSearch?: "search_assets" | "deep_search_assets";
};

export const AGENT_EVAL_TASKS: AgentEvalTask[] = [
	{
		id: "search-river",
		user: "Find the asset about a bicycle by the dock.",
		expectTools: ["search_assets"],
		forbidTools: ["bash", "powershell", "write", "edit"],
		argIncludes: { search_assets: { query: "bicycle|dock|river|bike|find" } },
	},
	{
		id: "find-by-name",
		user: "Find the file named river.md.",
		expectTools: ["search_assets"],
		forbidTools: ["bash", "powershell", "write", "edit"],
		argIncludes: { search_assets: { query: "river" } },
		firstSearch: "search_assets",
	},
	{
		id: "find-by-meaning",
		user: "Which note describes a two-wheeled vehicle waiting at a waterfront pier? Quote the line.",
		expectTools: ["deep_search_assets"],
		forbidTools: ["bash", "powershell", "write", "edit"],
		argIncludes: { deep_search_assets: { query: "." } },
		firstSearch: "deep_search_assets",
	},
	{
		id: "inspect-selection",
		user: "What's in this?",
		selection: { assetId: "eval-river", path: "notes/river.md", assetType: "text" },
		expectTools: ["inspect_asset"],
		forbidTools: ["search_assets", "deep_search_assets", "bash", "write", "edit"],
		argIncludes: { inspect_asset: { assetId: "eval-river" } },
	},
	{
		id: "inspect-chip",
		user: "Summarize this.",
		chips: [{ assetId: "eval-soup", path: "recipes/soup.md", assetType: "text" }],
		expectTools: ["inspect_asset"],
		forbidTools: ["search_assets", "deep_search_assets", "bash", "write", "edit"],
		argIncludes: { inspect_asset: { assetId: "eval-soup" } },
	},
	{
		id: "chitchat",
		user: "What is 2+2?",
		expectTools: [],
		forbidTools: ["bash", "powershell", "write", "edit", "search_assets", "deep_search_assets", "inspect_asset"],
		answerIncludes: ["4"],
	},
];

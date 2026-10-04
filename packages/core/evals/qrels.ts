import type { AssetPropertyFilter } from "../src/model/retrieval.ts";

export type RetrievalQrel = {
	id: string;
	query: string;
	relevant: string[];
	properties?: AssetPropertyFilter[];
};

/** Gold paths are library-relative. Do not store asset ids. */

export type RetrievalKind = "fts" | "semantic" | "property";

export function retrievalKind(id: string): RetrievalKind {
	if (id.startsWith("semantic-")) return "semantic";
	if (id.startsWith("prop-")) return "property";
	return "fts";
}

export const RETRIEVAL_QRELS: RetrievalQrel[] = [
	{ id: "fts-bicycle", query: "bicycle", relevant: ["notes/river.md"] },
	{ id: "fts-basil", query: "basil", relevant: ["recipes/soup.md"] },
	{ id: "fts-aurora", query: "Aurora", relevant: ["briefs/brand.md"] },
	{ id: "fts-invoice", query: "invoice", relevant: ["notes/invoice.md"] },
	{ id: "fts-establishing", query: "establishing", relevant: ["clips/hero.md"] },
	{ id: "fts-motorcycle", query: "motorcycle", relevant: ["notes/motorcycle.md"] },
	{ id: "fts-canoe", query: "canoe", relevant: ["notes/canoe.md"] },
	{ id: "fts-stew", query: "stew", relevant: ["recipes/stew.md"] },
	{ id: "fts-tomato", query: "tomato", relevant: ["recipes/soup.md", "recipes/salad.md"] },
	{ id: "semantic-bike", query: "two-wheeled vehicle at a waterfront pier", relevant: ["notes/river.md"] },
	{ id: "semantic-meal", query: "how to cook a warm red-fruit broth with herbs", relevant: ["recipes/soup.md"] },
	{ id: "semantic-color", query: "official look for the client identity", relevant: ["briefs/brand.md"] },
	{ id: "semantic-dusk-clip", query: "opening landscape frame in the evening light", relevant: ["clips/hero.md"] },
	{ id: "semantic-bill", query: "paper requesting payment for rented lamps", relevant: ["notes/invoice.md"] },
	{
		id: "prop-hold-bike",
		query: "bicycle",
		properties: [{ name: "Status", operator: "eq", value: "Hold" }],
		relevant: ["notes/river.md"],
	},
	{
		id: "prop-published-recipe",
		query: "basil",
		properties: [{ name: "Status", operator: "eq", value: "Published" }],
		relevant: ["recipes/soup.md"],
	},
	{
		id: "prop-published-brand",
		query: "Aurora",
		properties: [{ name: "Status", operator: "eq", value: "Published" }],
		relevant: ["briefs/brand.md"],
	},
];

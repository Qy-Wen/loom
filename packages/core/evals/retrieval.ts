/**
 * Retrieval quality over the in-repo gold set (Recall@k / nDCG@k).
 *
 *   pnpm --filter @loom/core eval:retrieval
 *   pnpm --filter @loom/core eval:retrieval:live
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EmbeddingProvider } from "../src/model/text-embed.ts";
import { LocalCore } from "../src/local-core.ts";
import { evalEmbeddingProvider } from "./embed.ts";
import { createHttpEmbeddingProvider, embeddingFromEnv } from "./http-embed.ts";
import { EVAL_FILES, EVAL_STATUS, EVAL_STATUS_BY_PATH } from "./library.ts";
import { mean, ndcgAtK, recallAtK } from "./metrics.ts";
import { RETRIEVAL_QRELS, retrievalKind, type RetrievalKind, type RetrievalQrel } from "./qrels.ts";

export const RETRIEVAL_K = 3;
/** Live semantic subset must clear this; keyword-axis eval still requires 1.0 overall. */
export const LIVE_SEMANTIC_MIN_RECALL = 0.5;

export type RetrievalCaseResult = {
	id: string;
	kind: RetrievalKind;
	query: string;
	ranked: string[];
	recall: number;
	ndcg: number;
};

export type RetrievalEvalResult = {
	k: number;
	provider: string;
	cases: RetrievalCaseResult[];
	meanRecall: number;
	meanNdcg: number;
	meanRecallByKind: Record<RetrievalKind, number>;
	meanNdcgByKind: Record<RetrievalKind, number>;
};

export async function writeEvalLibrary(root: string): Promise<void> {
	for (const file of EVAL_FILES) {
		const path = join(root, file.relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, file.text);
	}
}

export async function openScoredLibrary(provider: EmbeddingProvider): Promise<{ root: string; core: LocalCore }> {
	const root = await mkdtemp(join(tmpdir(), "loom-retrieval-eval-"));
	await writeEvalLibrary(root);
	const core = new LocalCore();
	const snapshot = await core.openLibrary(root);
	const status = await core.createProperty(EVAL_STATUS.name, "text");
	const byPath = new Map(snapshot.assets.map((asset) => [asset.relativePath, asset]));
	for (const [relativePath, value] of Object.entries(EVAL_STATUS_BY_PATH)) {
		const asset = byPath.get(relativePath);
		if (!asset) throw new Error(`Eval library missing ${relativePath}`);
		await core.setAssetProperty(asset.assetId, status.propertyId, value);
	}
	for (const asset of snapshot.assets) {
		if (asset.type !== "text") continue;
		const embedded = await core.embedTextAsset(asset.assetId, provider);
		if (embedded.status !== "ready") throw new Error(`Failed to embed ${asset.relativePath}`);
	}
	return { root, core };
}

function scoreCase(qrel: RetrievalQrel, ranked: string[], k: number): RetrievalCaseResult {
	return {
		id: qrel.id,
		kind: retrievalKind(qrel.id),
		query: qrel.query,
		ranked: ranked.slice(0, k),
		recall: recallAtK(ranked, qrel.relevant, k),
		ndcg: ndcgAtK(ranked, qrel.relevant, k),
	};
}

function meansByKind(cases: RetrievalCaseResult[]): {
	meanRecallByKind: Record<RetrievalKind, number>;
	meanNdcgByKind: Record<RetrievalKind, number>;
} {
	const kinds: RetrievalKind[] = ["fts", "semantic", "property"];
	const meanRecallByKind = { fts: 0, semantic: 0, property: 0 };
	const meanNdcgByKind = { fts: 0, semantic: 0, property: 0 };
	for (const kind of kinds) {
		const rows = cases.filter((row) => row.kind === kind);
		meanRecallByKind[kind] = mean(rows.map((row) => row.recall));
		meanNdcgByKind[kind] = mean(rows.map((row) => row.ndcg));
	}
	return { meanRecallByKind, meanNdcgByKind };
}

export async function runRetrievalEval(
	k = RETRIEVAL_K,
	provider: EmbeddingProvider = evalEmbeddingProvider(),
): Promise<RetrievalEvalResult> {
	const { root, core } = await openScoredLibrary(provider);
	try {
		const cases: RetrievalCaseResult[] = [];
		for (const qrel of RETRIEVAL_QRELS) {
			const result = await core.searchAssets(
				{ query: qrel.query, properties: qrel.properties, limit: k },
				provider,
			);
			const ranked = result.assets.map((asset) => asset.relativePath);
			cases.push(scoreCase(qrel, ranked, k));
		}
		return {
			k,
			provider: provider.modelId,
			cases,
			meanRecall: mean(cases.map((row) => row.recall)),
			meanNdcg: mean(cases.map((row) => row.ndcg)),
			...meansByKind(cases),
		};
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function print(result: RetrievalEvalResult): void {
	console.log(`Retrieval eval  Recall@${result.k} / nDCG@${result.k}  embed=${result.provider}\n`);
	for (const row of result.cases) {
		console.log(
			`  ${row.id.padEnd(24)} recall=${pct(row.recall)}  ndcg=${pct(row.ndcg)}  ` +
				`top=${row.ranked.join(", ") || "(none)"}`,
		);
	}
	console.log(`\n  mean recall  ${pct(result.meanRecall)}`);
	console.log(`  mean nDCG    ${pct(result.meanNdcg)}`);
	console.log(`  fts          ${pct(result.meanRecallByKind.fts)}`);
	console.log(`  semantic     ${pct(result.meanRecallByKind.semantic)}`);
	console.log(`  property     ${pct(result.meanRecallByKind.property)}`);
}

async function main(): Promise<void> {
	const live = process.argv.includes("--live");
	if (live) {
		const slot = embeddingFromEnv();
		if (!slot) {
			throw new Error("LOOM_EMBED_BASE_URL and LOOM_EMBED_MODEL are required for the live retrieval eval.");
		}
		const result = await runRetrievalEval(RETRIEVAL_K, createHttpEmbeddingProvider(slot));
		console.log("Embedding HTTP: @loom/core/embedding");
		print(result);
		if (result.meanRecallByKind.semantic < LIVE_SEMANTIC_MIN_RECALL) {
			throw new Error(
				`Semantic Recall@${result.k} ${pct(result.meanRecallByKind.semantic)} is below ${pct(LIVE_SEMANTIC_MIN_RECALL)}`,
			);
		}
		return;
	}
	print(await runRetrievalEval());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		await main();
		process.exit(0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

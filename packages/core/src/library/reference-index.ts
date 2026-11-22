import type { Asset } from "../model/asset.ts";
import type { GraphStore } from "../stores/types.ts";
import type { LibrarySituation } from "./handlers.ts";
import {
	createAssetLookup,
	extractCanvasReferences,
	extractMarkdownReferences,
	referenceSourceKind,
	resolveReferences,
	type RawReference,
} from "./references.ts";

/** Larger files are not read for references. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * Keeps the graph's reference edges in step with the Markdown and canvas files in the library.
 *
 * It remembers what each source file said, so only added or updated files are read again. When any
 * asset appears, moves or goes away, every remembered source is matched to assets again without
 * touching the disk. The graph is only written when a source's targets actually change.
 * Calls are serialized, so overlapping library events cannot interleave their writes.
 */
export class ReferenceIndex {
	private readonly graph: Pick<GraphStore, "replaceReferences">;
	private readonly readSource: (relativePath: string) => Promise<string>;
	private readonly written = new Map<string, string>();
	private readonly raw = new Map<string, RawReference[]>();
	private queue: Promise<void> = Promise.resolve();

	constructor(graph: Pick<GraphStore, "replaceReferences">, readSource: (relativePath: string) => Promise<string>) {
		this.graph = graph;
		this.readSource = readSource;
	}

	/** Forget everything. The next sync reads every source and reconciles with the graph's stored edges. */
	reset(): void {
		this.queue = this.queue.then(() => {
			this.raw.clear();
			this.written.clear();
		});
	}

	/** Bring reference edges up to date for the full asset list after `situations` happened. */
	sync(assets: readonly Asset[], situations: readonly LibrarySituation[]): Promise<void> {
		const run = this.queue.then(() => this.apply(assets, situations));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async apply(assets: readonly Asset[], situations: readonly LibrarySituation[]): Promise<void> {
		const lookup = createAssetLookup(assets);
		const changed = new Set(
			situations.flatMap((situation) => (situation.type === "added" || situation.type === "updated" ? [situation.asset.assetId] : [])),
		);
		for (const situation of situations) {
			if (situation.type !== "moved") continue;
			const previousKind = referenceSourceKind(situation.previousPath);
			if (!previousKind || previousKind === referenceSourceKind(situation.asset.relativePath)) continue;
			const { assetId } = situation.asset;
			await this.graph.replaceReferences(assetId, previousKind, []);
			this.raw.delete(assetId);
			this.written.delete(assetId);
		}
		for (const assetId of this.raw.keys()) {
			if (lookup.byId(assetId)) continue;
			this.raw.delete(assetId);
			this.written.delete(assetId);
		}
		for (const asset of assets) {
			const kind = referenceSourceKind(asset.relativePath);
			if (!kind) continue;
			if (!this.raw.has(asset.assetId) || changed.has(asset.assetId)) {
				const extracted = await this.extract(asset);
				// An unreadable file keeps its previous result instead of losing its edges.
				if (extracted) this.raw.set(asset.assetId, extracted);
			}
			const references = this.raw.get(asset.assetId);
			if (!references) continue;
			const { targetAssetIds } = resolveReferences(asset.relativePath, references, lookup);
			const key = `${kind}\n${targetAssetIds.join("\n")}`;
			if (this.written.get(asset.assetId) === key) continue;
			await this.graph.replaceReferences(asset.assetId, kind, targetAssetIds);
			this.written.set(asset.assetId, key);
		}
	}

	private async extract(asset: Asset): Promise<RawReference[] | undefined> {
		if (asset.size > MAX_SOURCE_BYTES) return [];
		let text: string;
		try {
			text = await this.readSource(asset.relativePath);
		} catch {
			return undefined;
		}
		return referenceSourceKind(asset.relativePath) === "canvas"
			? extractCanvasReferences(text)
			: extractMarkdownReferences(text);
	}
}

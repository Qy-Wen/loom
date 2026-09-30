import { randomUUID } from "node:crypto";
import { EnrichmentService } from "./enrichment/service.ts";
import { Library } from "./library/library.ts";
import { LibraryHandlers, StoreGraphHandlers } from "./library/handlers.ts";
import { LibraryPaths } from "./library/paths.ts";
import type { Asset, LibraryChange, LibrarySnapshot } from "./model/asset.ts";
import type { AssetEnrichment } from "./model/enrichment.ts";
import type { NearestChildHit } from "./model/hybrid.ts";
import type { EmbeddingProvider, TextEmbedStatus } from "./model/text-embed.ts";
import type { RerankProvider } from "./model/rerank.ts";
import type { ImageVlmProvider, ImageVlmStatus } from "./model/image-vlm.ts";
import type { VideoVlmProvider, VideoVlmStatus } from "./model/video-vlm.ts";
import type { AudioWriteupProvider, AudioWriteupStatus } from "./model/audio-writeup.ts";
import { ImageVlmService } from "./rag/image-vlm.ts";
import { extractVideoFramesForVlm } from "./rag/video-frames.ts";
import { VideoVlmService } from "./rag/video-vlm.ts";
import { prepareAudioForModel } from "./rag/audio-prepare.ts";
import { AudioWriteupService } from "./rag/audio-writeup.ts";
import { TextEmbedService } from "./rag/service.ts";
import type {
	AssetPropertyValue,
	PropertyDefinition,
	PropertySnapshot,
	PropertyType,
	PropertyValue,
} from "./model/property.ts";
import {
	toSearchItem,
	type AssetDetailResult,
	type AssetPropertyFilter,
	type AssetPropertyView,
	type AssetLinkView,
	type AssetRelationView,
	type AssetRelationsResult,
	type AssetSearchItem,
	type AssetSearchQuery,
	type AssetSearchResult,
} from "./model/retrieval.ts";
import { matchesPropertyFilters } from "./retrieval/filter.ts";
import { HYBRID_CANDIDATES, rrfFuse, uniqueInOrder } from "./retrieval/rrf.ts";
import { rerankHits } from "./retrieval/rerank.ts";
import { MediaService } from "./media/service.ts";
import { resolveMediaPath } from "./media/policy.ts";
import type {
	ConvertFormatArgs,
	CropVideoArgs,
	ExtractClipArgs,
	ExtractFrameArgs,
	MediaInfoResult,
	MediaJobResult,
	ResizeVideoArgs,
	RunFfmpegArgs,
} from "./model/media.ts";
import type { LoomTranscriptMessage, SessionRecord, SessionSummary } from "./model/session.ts";
import { JsonlSessionRepo } from "./sessions/repo.ts";
import { LadybugGraphStore } from "./stores/ladybug.ts";
import { SqliteMetadataStore } from "./stores/sqlite.ts";
import {
	GENERATED_FROM,
	normalizeRelationType,
	type AssetRelation,
	type GraphStore,
	type MetadataStore,
} from "./stores/types.ts";

export interface LocalCoreOptions {
	metadataStore?: MetadataStore;
	graphStore?: GraphStore;
}

/** Main-process facade. Renderer code talks to this only through typed IPC. */
export class LocalCore {
	readonly metadataStore: MetadataStore;
	readonly graphStore: GraphStore;
	private readonly library: Library;
	private readonly enrichment: EnrichmentService;
	private readonly textEmbed: TextEmbedService;
	private readonly imageVlm: ImageVlmService;
	private readonly videoVlm: VideoVlmService;
	private readonly audioWriteup: AudioWriteupService;
	private readonly media: MediaService;
	private sessions: JsonlSessionRepo | null = null;
	private readonly sessionListeners = new Set<(sessions: SessionSummary[]) => void>();

	constructor(options: LocalCoreOptions = {}) {
		this.metadataStore = options.metadataStore ?? new SqliteMetadataStore();
		this.graphStore = options.graphStore ?? new LadybugGraphStore();
		this.library = new Library(new LibraryHandlers(this.metadataStore, new StoreGraphHandlers(this.graphStore)));
		this.enrichment = new EnrichmentService(
			this.metadataStore,
			(assetId) => this.library.getAssetFilePath(assetId),
		);
		this.textEmbed = new TextEmbedService(this.metadataStore, this.enrichment);
		this.imageVlm = new ImageVlmService(
			this.metadataStore,
			(assetId) => this.library.getAssetFilePath(assetId),
		);
		this.videoVlm = new VideoVlmService(
			this.metadataStore,
			(assetId) => this.library.getAssetFilePath(assetId),
			extractVideoFramesForVlm,
		);
		this.audioWriteup = new AudioWriteupService(
			this.metadataStore,
			(assetId) => this.library.getAssetFilePath(assetId),
			prepareAudioForModel,
		);
		this.media = new MediaService(this.library);
		this.library.subscribe((change) => {
			if (change.type === "reset") {
				void this.enrichment.refreshStale(change.snapshot.assets).then((records) => {
					for (const record of records) this.library.notifyEnrichment(record.assetId);
				}).catch(() => undefined);
			} else if (change.type === "upsert") {
				void this.enrichment.refreshStale([change.asset]).then((records) => {
					for (const record of records) this.library.notifyEnrichment(record.assetId);
				}).catch(() => undefined);
			}
		});
	}

	async openLibrary(rootPath: string): Promise<LibrarySnapshot> {
		this.sessions?.resetHandles();
		this.sessions = null;
		await this.graphStore.close();
		const paths = new LibraryPaths(rootPath);
		await this.graphStore.open(paths);
		const snapshot = await this.library.open(rootPath);
		this.sessions = new JsonlSessionRepo(paths.sessions);
		return snapshot;
	}

	getLibrarySnapshot(): Promise<LibrarySnapshot> {
		return this.library.getSnapshot();
	}

	getAssetFilePath(assetId: string): Promise<string | undefined> {
		return this.library.getAssetFilePath(assetId);
	}

	renameAsset(assetId: string, stem: string): Promise<Asset> {
		return this.library.renameAsset(assetId, stem);
	}

	duplicateAsset(assetId: string): Promise<Asset> {
		return this.library.duplicateAsset(assetId);
	}

	createFolder(parentRelativePath: string, name?: string): Promise<string> {
		return this.library.createFolder(parentRelativePath, name);
	}

	createMarkdownFile(parentRelativePath: string): Promise<Asset> {
		return this.library.createMarkdownFile(parentRelativePath);
	}

	renameFolder(relativePath: string, name: string): Promise<string> {
		return this.library.renameFolder(relativePath, name);
	}

	copyAssetsInto(assetIds: string[], destFolder: string): Promise<Asset[]> {
		return this.library.copyAssetsInto(assetIds, destFolder);
	}

	copyFolderInto(sourceFolder: string, destFolder: string): Promise<string> {
		return this.library.copyFolderInto(sourceFolder, destFolder);
	}

	getFolderFilePath(relativePath: string): string {
		return this.library.getFolderFilePath(relativePath);
	}

	forgetFolder(relativePath: string): Promise<void> {
		return this.library.forgetFolder(relativePath);
	}

	forgetAsset(assetId: string): Promise<void> {
		return this.library.forgetAsset(assetId);
	}

	async getPropertySnapshot(): Promise<PropertySnapshot> {
		const [properties, values] = await Promise.all([
			this.metadataStore.listProperties(),
			this.metadataStore.listAllAssetProperties(),
		]);
		return { properties, values };
	}

	async createProperty(name: string, type: PropertyType): Promise<PropertyDefinition> {
		const property: PropertyDefinition = {
			propertyId: randomUUID(),
			name: name.trim(),
			type,
			createdAt: Date.now(),
		};
		await this.metadataStore.createProperty(property);
		return property;
	}

	async updateProperty(
		propertyId: string,
		name: string,
		type: PropertyType,
	): Promise<PropertyDefinition> {
		const previous = await this.metadataStore.getProperty(propertyId);
		if (!previous) throw new Error("Property not found");
		const property = { ...previous, name: name.trim(), type };
		await this.metadataStore.updateProperty(property);
		return property;
	}

	removeProperty(propertyId: string): Promise<void> {
		return this.metadataStore.removeProperty(propertyId);
	}

	async setAssetProperty(
		assetId: string,
		propertyId: string,
		value: PropertyValue,
	): Promise<AssetPropertyValue> {
		const assetProperty = { assetId, propertyId, value };
		await this.metadataStore.setAssetProperty(assetProperty);
		return assetProperty;
	}

	removeAssetProperty(assetId: string, propertyId: string): Promise<void> {
		return this.metadataStore.removeAssetProperty(assetId, propertyId);
	}

	async searchAssets(
		query: AssetSearchQuery = {},
		provider?: EmbeddingProvider,
		rerank?: RerankProvider,
		signal?: AbortSignal,
	): Promise<AssetSearchResult> {
		const textQuery = query.query?.trim();
		const [assets, definitions, values, ftsIds, nearest] = await Promise.all([
			this.metadataStore.listAssets(),
			this.metadataStore.listProperties(),
			this.metadataStore.listAllAssetProperties(),
			textQuery ? this.metadataStore.searchAssetIds(textQuery) : Promise.resolve([] as string[]),
			textQuery ? this.nearestChildrenForQuery(textQuery, provider, signal) : Promise.resolve([] as NearestChildHit[]),
		]);
		const definitionsById = new Map(definitions.map((property) => [property.propertyId, property]));
		const definitionByName = new Map(
			definitions.map((property) => [property.name.trim().toLowerCase(), property]),
		);
		const propertiesByAsset = new Map<string, AssetPropertyView[]>();
		for (const value of values) {
			const definition = definitionsById.get(value.propertyId);
			if (!definition) continue;
			const list = propertiesByAsset.get(value.assetId) ?? [];
			list.push({
				propertyId: definition.propertyId,
				name: definition.name,
				type: definition.type,
				value: value.value,
			});
			propertiesByAsset.set(value.assetId, list);
		}
		const assetsById = new Map(assets.map((asset) => [asset.assetId, asset]));
		const filters = query.properties ?? [];
		const passes = (assetId: string): boolean => {
			const asset = assetsById.get(assetId);
			if (!asset) return false;
			if (query.type && asset.type !== query.type) return false;
			return matchesPropertyFilters(propertiesByAsset.get(assetId) ?? [], filters, definitionByName);
		};

		const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 20)));
		if (!textQuery) {
			const matches = assets
				.filter((asset) => passes(asset.assetId))
				.map((asset) => toSearchItem(asset, propertiesByAsset.get(asset.assetId) ?? []));
			return { kind: "asset_list", assets: matches.slice(0, limit), total: matches.length };
		}

		const ftsRanked = uniqueInOrder(ftsIds.filter(passes)).slice(0, HYBRID_CANDIDATES);
		const vecRanked: string[] = [];
		const bestChild = new Map<string, NearestChildHit>();
		for (const hit of nearest) {
			if (!passes(hit.assetId) || bestChild.has(hit.assetId)) continue;
			bestChild.set(hit.assetId, hit);
			vecRanked.push(hit.assetId);
			if (vecRanked.length >= HYBRID_CANDIDATES) break;
		}

		const matches: AssetSearchItem[] = [];
		for (const { id, score } of rrfFuse([ftsRanked, vecRanked])) {
			const asset = assetsById.get(id);
			if (!asset) continue;
			const child = bestChild.get(id);
			matches.push({
				...toSearchItem(asset, propertiesByAsset.get(id) ?? []),
				score,
				...(child
					? { passage: child.text, parentPassage: child.parentText, chunkId: child.chunkId }
					: {}),
			});
		}
		const ranked = await this.rerankMatches(textQuery, matches, rerank, signal);
		return { kind: "asset_list", assets: ranked.slice(0, limit), total: ranked.length };
	}

	private async rerankMatches(
		query: string,
		matches: AssetSearchItem[],
		rerank?: RerankProvider,
		signal?: AbortSignal,
	): Promise<AssetSearchItem[]> {
		if (!rerank || matches.length < 2) return matches;
		const documents = matches.map((hit) => hit.passage ?? hit.parentPassage ?? hit.filename);
		try {
			const scores = await rerank.rerank(query, documents, signal);
			if (scores.length !== matches.length) return matches;
			return rerankHits(matches, scores);
		} catch (error) {
			if (signal?.aborted) throw error;
			return matches;
		}
	}

	private async nearestChildrenForQuery(
		text: string,
		provider?: EmbeddingProvider,
		signal?: AbortSignal,
	): Promise<NearestChildHit[]> {
		if (!provider) return [];
		try {
			const [vector] = await provider.embed([text], signal);
			if (!vector?.length) return [];
			return this.metadataStore.searchNearestChildren(vector, HYBRID_CANDIDATES);
		} catch (error) {
			if (signal?.aborted) throw error;
			return [];
		}
	}

	async inspectAsset(assetId: string): Promise<AssetDetailResult> {
		const asset = await this.metadataStore.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		const [definitions, values] = await Promise.all([
			this.metadataStore.listProperties(),
			this.metadataStore.listAssetProperties(assetId),
		]);
		const definitionsById = new Map(definitions.map((property) => [property.propertyId, property]));
		const properties: AssetPropertyView[] = [];
		for (const value of values) {
			const definition = definitionsById.get(value.propertyId);
			if (!definition) continue;
			properties.push({
				propertyId: definition.propertyId,
				name: definition.name,
				type: definition.type,
				value: value.value,
			});
		}
		return {
			kind: "asset_detail",
			...toSearchItem(asset, properties),
			createdAt: asset.createdAt,
			previewRef: `loom-asset://asset/${encodeURIComponent(asset.assetId)}?v=${asset.modifiedAt}`,
			enrichment: await this.metadataStore.getAssetEnrichment(asset.assetId),
			textEmbed: await this.textEmbed.getStatus(asset.assetId),
			imageVlm: await this.imageVlm.getStatus(asset.assetId),
			videoVlm: await this.videoVlm.getStatus(asset.assetId),
			audioWriteup: await this.audioWriteup.getStatus(asset.assetId),
			...await this.listAssetRelations(asset.assetId),
		};
	}

	listGraphRelations(): Promise<AssetRelation[]> {
		return this.graphStore.listAllRelations();
	}

	async createRelation(fromAssetId: string, toAssetId: string, type: string): Promise<AssetRelation> {
		const relationType = normalizeRelationType(type);
		if (fromAssetId === toAssetId) throw new Error("Cannot relate an asset to itself");
		const [from, to] = await Promise.all([
			this.metadataStore.getAsset(fromAssetId),
			this.metadataStore.getAsset(toAssetId),
		]);
		if (!from || !to) throw new Error("Asset not found");
		const relation: AssetRelation = {
			relationId: `${fromAssetId}:${toAssetId}:${relationType}`,
			fromAssetId,
			toAssetId,
			type: relationType,
		};
		await this.graphStore.upsertRelation(relation);
		return relation;
	}

	async removeRelation(relationId: string): Promise<void> {
		if (!relationId.trim()) throw new Error("Relation not found");
		await this.graphStore.removeRelation(relationId);
	}

	async listAssetRelations(assetId: string): Promise<AssetRelationsResult> {
		const relations = await this.graphStore.listRelations(assetId);
		const generatedFrom: AssetRelationView[] = [];
		const generated: AssetRelationView[] = [];
		const links: AssetLinkView[] = [];
		for (const relation of relations) {
			const outgoing = relation.fromAssetId === assetId;
			const otherId = outgoing ? relation.toAssetId : relation.fromAssetId;
			const other = await this.metadataStore.getAsset(otherId);
			if (!other) continue;
			const view = toRelationView(other);
			links.push({
				relationId: relation.relationId,
				relationType: relation.type,
				direction: outgoing ? "out" : "in",
				asset: view,
			});
			if (relation.type !== GENERATED_FROM) continue;
			if (outgoing) generatedFrom.push(view);
			else generated.push(view);
		}
		generatedFrom.sort(compareRelationView);
		generated.sort(compareRelationView);
		links.sort((a, b) => (
			a.relationType.localeCompare(b.relationType)
			|| a.direction.localeCompare(b.direction)
			|| compareRelationView(a.asset, b.asset)
		));
		return { generatedFrom, generated, links };
	}

	getAssetEnrichment(assetId: string): Promise<AssetEnrichment | undefined> {
		return this.metadataStore.getAssetEnrichment(assetId);
	}

	async analyzeAsset(assetId: string): Promise<AssetEnrichment> {
		const record = await this.enrichment.analyze(assetId);
		this.library.notifyEnrichment(assetId);
		return record;
	}

	getTextEmbedStatus(assetId: string, currentModelId?: string): Promise<TextEmbedStatus> {
		return this.textEmbed.getStatus(assetId, currentModelId);
	}

	async embedTextAsset(
		assetId: string,
		provider: EmbeddingProvider,
		signal?: AbortSignal,
	): Promise<TextEmbedStatus> {
		const status = await this.textEmbed.embed(assetId, provider, () => {
			this.library.notifyTextEmbed(assetId);
		}, signal);
		this.library.notifyTextEmbed(assetId);
		return status;
	}

	getImageVlmStatus(assetId: string, currentModelId?: string): Promise<ImageVlmStatus> {
		return this.imageVlm.getStatus(assetId, currentModelId);
	}

	async describeImageAsset(
		assetId: string,
		provider: ImageVlmProvider,
		signal?: AbortSignal,
	): Promise<ImageVlmStatus> {
		const status = await this.imageVlm.describe(assetId, provider, () => {
			this.library.notifyImageVlm(assetId);
		}, signal);
		this.library.notifyImageVlm(assetId);
		return status;
	}

	getVideoVlmStatus(assetId: string, currentModelId?: string): Promise<VideoVlmStatus> {
		return this.videoVlm.getStatus(assetId, currentModelId);
	}

	async describeVideoAsset(
		assetId: string,
		provider: VideoVlmProvider,
		signal?: AbortSignal,
	): Promise<VideoVlmStatus> {
		const status = await this.videoVlm.describe(assetId, provider, () => {
			this.library.notifyVideoVlm(assetId);
		}, signal);
		this.library.notifyVideoVlm(assetId);
		return status;
	}

	getAudioWriteupStatus(assetId: string, currentModelId?: string): Promise<AudioWriteupStatus> {
		return this.audioWriteup.getStatus(assetId, currentModelId);
	}

	async describeAudioAsset(
		assetId: string,
		provider: AudioWriteupProvider,
		signal?: AbortSignal,
	): Promise<AudioWriteupStatus> {
		const status = await this.audioWriteup.describe(assetId, provider, () => {
			this.library.notifyAudioWriteup(assetId);
		}, signal);
		this.library.notifyAudioWriteup(assetId);
		return status;
	}

	refreshEnrichment(assets: Asset[]): Promise<AssetEnrichment[]> {
		return this.enrichment.refreshStale(assets);
	}

	getMediaInfo(path: string, signal?: AbortSignal): Promise<MediaInfoResult> {
		return this.media.getMediaInfo(path, signal);
	}

	async extractFrame(args: ExtractFrameArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		return this.runConvenience(args.path, () => this.media.extractFrame(args, signal));
	}

	async extractClip(args: ExtractClipArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		return this.runConvenience(args.path, () => this.media.extractClip(args, signal));
	}

	async resizeVideo(args: ResizeVideoArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		return this.runConvenience(args.path, () => this.media.resizeVideo(args, signal));
	}

	async cropVideo(args: CropVideoArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		return this.runConvenience(args.path, () => this.media.cropVideo(args, signal));
	}

	async convertFormat(args: ConvertFormatArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		return this.runConvenience(args.path, () => this.media.convertFormat(args, signal));
	}

	runFfmpeg(args: RunFfmpegArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		return this.media.runFfmpeg(args, signal);
	}

	subscribeLibrary(listener: (change: LibraryChange) => void): () => void {
		return this.library.subscribe(listener);
	}

	subscribeSessions(listener: (sessions: SessionSummary[]) => void): () => void {
		this.sessionListeners.add(listener);
		return () => this.sessionListeners.delete(listener);
	}

	async listSessions(): Promise<SessionSummary[]> {
		return this.requireSessions().list();
	}

	async createSession(): Promise<SessionRecord> {
		const repo = this.requireSessions();
		repo.resetHandles();
		const created = await repo.create();
		await this.emitSessions();
		return created;
	}

	async getSession(id: string): Promise<SessionRecord> {
		return this.requireSessions().get(id);
	}

	async openSession(id: string): Promise<SessionRecord> {
		const repo = this.requireSessions();
		repo.resetHandles();
		return repo.open(id);
	}

	closeSessionHandle(id: string): void {
		this.sessions?.closeHandle(id);
	}

	resetSessionHandles(): void {
		this.sessions?.resetHandles();
	}

	async appendSessionMessages(id: string, messages: LoomTranscriptMessage[]): Promise<void> {
		return this.requireSessions().appendMessages(id, messages);
	}

	async setSessionName(id: string, title: string): Promise<void> {
		await this.requireSessions().setName(id, title);
		await this.emitSessions();
	}

	async archiveSession(id: string): Promise<void> {
		await this.requireSessions().setStatus(id, "archived");
		await this.emitSessions();
	}

	async unarchiveSession(id: string): Promise<void> {
		await this.requireSessions().setStatus(id, "open");
		await this.emitSessions();
	}

	async deleteSession(id: string): Promise<void> {
		await this.requireSessions().delete(id);
		await this.emitSessions();
	}

	async close(): Promise<void> {
		this.sessions?.resetHandles();
		this.sessions = null;
		await Promise.all([this.library.close(), this.graphStore.close()]);
	}

	private requireSessions(): JsonlSessionRepo {
		if (!this.sessions) throw new Error("No library is open");
		return this.sessions;
	}

	private async emitSessions(): Promise<void> {
		if (!this.sessions || this.sessionListeners.size === 0) return;
		const sessions = await this.sessions.list();
		for (const listener of this.sessionListeners) listener(sessions);
	}

	private async runConvenience(
		inputPath: string,
		run: () => Promise<MediaJobResult>,
	): Promise<MediaJobResult> {
		const result = await run();
		await this.recordGeneratedFrom(inputPath, result);
		return result;
	}

	private async recordGeneratedFrom(inputPath: string, result: MediaJobResult): Promise<void> {
		const sourceRel = this.libraryRelative(inputPath);
		if (!sourceRel) return;
		const source = await this.metadataStore.getAssetByPath(sourceRel);
		if (!source) return;

		const outputs = [...new Set(result.outputs ?? (result.output ? [result.output] : []))];
		for (const outputPath of outputs) {
			const outputRel = this.libraryRelative(outputPath);
			if (!outputRel) continue;
			const output = await this.library.indexFile(outputRel);
			if (!output || output.assetId === source.assetId) continue;
			await this.graphStore.upsertRelation({
				relationId: `${output.assetId}:${source.assetId}:${GENERATED_FROM}`,
				fromAssetId: output.assetId,
				toAssetId: source.assetId,
				type: GENERATED_FROM,
			});
		}
	}

	private libraryRelative(path: string): string | undefined {
		try {
			const paths = this.library.getPaths();
			return paths.toRelativePath(resolveMediaPath(path, paths.root).absolutePath);
		} catch {
			return undefined;
		}
	}
}

function toRelationView(asset: Asset): AssetRelationView {
	return {
		assetId: asset.assetId,
		filename: asset.filename,
		relativePath: asset.relativePath,
		type: asset.type,
	};
}

function compareRelationView(a: AssetRelationView, b: AssetRelationView): number {
	return a.relativePath.localeCompare(b.relativePath) || a.assetId.localeCompare(b.assetId);
}

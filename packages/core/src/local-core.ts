import { LibraryTaskScope, abortableProviderCall } from "./library/task-scope.ts";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isGradeableVideo } from "./grade/types.ts";
import { EnrichmentService } from "./enrichment/service.ts";
import { Library } from "./library/library.ts";
import { LibraryHandlers, StoreGraphHandlers } from "./library/handlers.ts";
import { LibraryPaths } from "./library/paths.ts";
import type { Asset, LibraryChange, LibrarySnapshot } from "./model/asset.ts";
import type { AssetRelation } from "./model/relation.ts";
import type { AssetEnrichment } from "./model/enrichment.ts";
import type { ChunkHit } from "./model/hybrid.ts";
import type { EmbeddingProvider, TextEmbedStatus } from "./model/text-embed.ts";
import type { RerankProvider } from "./model/rerank.ts";
import type { ImageVlmProvider, ImageVlmStatus } from "./model/image-vlm.ts";
import type { VideoVlmProvider, VideoVlmStatus } from "./model/video-vlm.ts";
import type { AudioWriteupProvider, AudioWriteupStatus } from "./model/audio-writeup.ts";
import type { DescribeOptions } from "./rag/description.ts";
import { ImageVlmService } from "./rag/image-vlm.ts";
import { extractVideoFramesForVlm } from "./rag/video-frames.ts";
import { VideoVlmService } from "./rag/video-vlm.ts";
import { prepareAudioForModel } from "./rag/audio-prepare.ts";
import { prepareImageForModel } from "./rag/image-prepare.ts";
import { AudioWriteupService } from "./rag/audio-writeup.ts";
import { TextEmbedService, type EmbedOptions } from "./rag/service.ts";
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
	type AssetPropertyView,
	type AssetLinkView,
	type AssetRelationView,
	type AssetRelationsResult,
	type AssetSearchItem,
	type AssetSearchQuery,
	type AssetSearchResult,
	type DeepSearchResult,
} from "./model/retrieval.ts";
import { matchesPropertyFilters } from "./retrieval/filter.ts";
import { bestChunkPerFile, fuseChunks } from "./retrieval/deep.ts";
import { HYBRID_CANDIDATES, uniqueInOrder } from "./retrieval/rrf.ts";
import { rerankHits } from "./retrieval/rerank.ts";
import { MediaService } from "./media/service.ts";
import type {
	GradeImageArgs,
	GradeImageResult,
	GradeVideoArgs,
	GradeVideoResult,
	MediaInfoResult,
	MediaJobResult,
	RunFfmpegArgs,
	RunFfprobeArgs,
} from "./model/media.ts";
import { LadybugGraphStore } from "./stores/ladybug.ts";
import { SqliteMetadataStore } from "./stores/sqlite.ts";
import {
	normalizeRelationType,
	type GraphStore,
	type MetadataStore,
} from "./stores/types.ts";

export interface LocalCoreOptions {
	metadataStore?: MetadataStore;
	graphStore?: GraphStore;
}

/** Library domain facade. Desktop integration and provider implementations live in app. */
export class LocalCore {
	private readonly metadataStore: MetadataStore;
	private readonly graphStore: GraphStore;
	private readonly library: Library;
	private readonly enrichment: EnrichmentService;
	private readonly textEmbed: TextEmbedService;
	private readonly imageVlm: ImageVlmService;
	private readonly videoVlm: VideoVlmService;
	private readonly audioWriteup: AudioWriteupService;
	private readonly media: MediaService;
	private tasks: LibraryTaskScope | undefined;
	private transition: Promise<void> = Promise.resolve();
	private transitions = 0;

	constructor(options: LocalCoreOptions = {}) {
		this.metadataStore = options.metadataStore ?? new SqliteMetadataStore();
		this.graphStore = options.graphStore ?? new LadybugGraphStore();
		this.library = new Library(new LibraryHandlers(this.metadataStore, new StoreGraphHandlers(this.graphStore)));
		this.enrichment = new EnrichmentService(
			this.metadataStore,
			(assetId) => this.library.getAssetFilePath(assetId),
		);
		this.textEmbed = new TextEmbedService(
			this.metadataStore,
			(assetId) => this.library.getAssetFilePath(assetId),
		);
		this.imageVlm = new ImageVlmService(
			this.metadataStore,
			(assetId) => this.library.getAssetFilePath(assetId),
			prepareImageForModel,
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
			const tasks = this.tasks;
			if (!tasks?.active) return;
			const assets = change.type === "reset" ? change.snapshot.assets : change.type === "upsert" ? [change.asset] : undefined;
			if (assets) void tasks.run(async (signal) => {
				const records = await this.enrichment.refreshStale(assets, signal);
				if (tasks.active) for (const record of records) this.library.notifyEnrichment(record.assetId);
			}).catch(() => undefined);
		});
	}

	sqliteVecNote(): string | undefined {
		return this.metadataStore instanceof SqliteMetadataStore ? this.metadataStore.sqliteVecNote() : undefined;
	}

	openLibrary(rootPath: string): Promise<LibrarySnapshot> {
		return this.changeLibrary(async () => {
			await this.closeCurrentLibrary();
			this.tasks = new LibraryTaskScope();
			try {
				if (!(await stat(rootPath)).isDirectory()) throw new Error("Library path is not a directory");
				await this.graphStore.open(new LibraryPaths(rootPath));
				return await this.library.open(rootPath);
			} catch (error) {
				await this.closeCurrentLibrary();
				throw error;
			}
		});
	}

	/** Bind preparatory awaits (such as model settings reads) to this opening too. */
	runLibraryTask<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!this.tasks?.active || this.transitions) return Promise.reject(new Error("Library is not accepting operations"));
		return this.tasks.run(work, signal);
	}

	/** Stop admission immediately, before application-owned tools are closed. */
	async stopLibraryTasks(): Promise<void> {
		const tasks = this.tasks;
		tasks?.cancel();
		await tasks?.drain();
	}

	private changeLibrary<T>(work: () => Promise<T>): Promise<T> {
		this.transitions++;
		this.tasks?.cancel();
		const result = this.transition.then(work);
		this.transition = result.then(() => undefined, () => undefined);
		return result.finally(() => { this.transitions--; });
	}

	private async closeCurrentLibrary(): Promise<void> {
		this.tasks?.cancel();
		await this.library.stopWatching();
		await this.tasks?.drain();
		await this.library.close();
		await this.graphStore.close();
		await this.media.releaseScratch();
		this.tasks = undefined;
	}

	getLibrarySnapshot(): Promise<LibrarySnapshot> {
		return this.library.getSnapshot();
	}

	setFavorite(assetId: string, favorite: boolean): Promise<void> {
		return this.library.setFavorite(assetId, favorite);
	}

	addAssetTag(assetId: string, name: string): Promise<void> {
		return this.library.addAssetTag(assetId, name);
	}

	removeAssetTag(assetId: string, tagId: string): Promise<void> {
		return this.library.removeAssetTag(assetId, tagId);
	}

	/** Every tag in the library with the number of files that carry it, most used first. */
	async listTagUsage(): Promise<Array<{ name: string; count: number }>> {
		const [tags, links] = await Promise.all([this.metadataStore.listTags(), this.metadataStore.listAssetTags()]);
		const counts = new Map<string, number>();
		for (const link of links) counts.set(link.tagId, (counts.get(link.tagId) ?? 0) + 1);
		return tags
			.map((tag) => ({ name: tag.name, count: counts.get(tag.tagId) ?? 0 }))
			.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
	}

	/** Take a tag off one file by its name, ignoring case. Returns false when the file did not have it. */
	async removeAssetTagByName(assetId: string, name: string): Promise<boolean> {
		if (!await this.metadataStore.getAsset(assetId)) throw new Error("Asset not found");
		const key = name.trim().toLowerCase();
		const tag = (await this.metadataStore.listTags()).find((candidate) => candidate.name.toLowerCase() === key);
		if (!tag) return false;
		const has = (await this.metadataStore.listAssetTags()).some((link) => link.assetId === assetId && link.tagId === tag.tagId);
		if (!has) return false;
		await this.library.removeAssetTag(assetId, tag.tagId);
		return true;
	}

	getAsset(assetId: string): Promise<Asset | undefined> {
		return this.metadataStore.getAsset(assetId);
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

	moveAssetsInto(assetIds: string[], destFolder: string): Promise<Asset[]> {
		return this.library.moveAssetsInto(assetIds, destFolder);
	}

	moveFolderInto(sourceFolder: string, destFolder: string): Promise<string> {
		return this.library.moveFolderInto(sourceFolder, destFolder);
	}

	importExternalFiles(absolutePaths: string[]): Promise<Asset[]> {
		return this.library.importExternalFiles(absolutePaths);
	}

	placePathsInto(absolutePaths: string[], destFolder: string, move: boolean) {
		return this.library.placePathsInto(absolutePaths, destFolder, move);
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

	/**
	 * Simple search: file-level full text over filename, path, properties, extracts, and
	 * write-ups, plus type and property filters. No models. With no text it lists files.
	 */
	searchAssets(query: AssetSearchQuery = {}, signal?: AbortSignal): Promise<AssetSearchResult> {
		return this.runLibraryTask(async () => {
			const view = await this.searchView(query);
			const textQuery = query.query?.trim();
			if (!textQuery) return view.list();
			const ids = uniqueInOrder((await this.metadataStore.searchAssetIds(textQuery)).filter(view.passes));
			const items = ids.flatMap((id) => {
				const asset = view.assetsById.get(id);
				return asset ? [toSearchItem(asset, view.propertiesOf(id))] : [];
			});
			return { kind: "asset_list", assets: items.slice(0, view.limit), total: items.length };
		}, signal);
	}

	/**
	 * Deep search: matching passages in indexed files. Chunk full text and chunk vectors are
	 * fused with RRF, filtered, optionally reranked on the passage text, and cut to each file's
	 * best passage. Without an Embedding provider only full text runs. A file with no index is
	 * invisible here; `indexedCount` says how many files are searchable.
	 */
	deepSearchAssets(
		query: AssetSearchQuery & { query: string },
		provider?: EmbeddingProvider,
		rerank?: RerankProvider,
		signal?: AbortSignal,
	): Promise<DeepSearchResult> {
		return this.runLibraryTask(async (jobSignal) => {
			const textQuery = query.query.trim();
			const view = await this.searchView(query);
			const indexedCount = await this.metadataStore.countIndexedAssets();
			if (!textQuery) return { ...view.list(), indexedCount };
			const [fullText, vector] = await Promise.all([
				this.metadataStore.searchChunksFts(textQuery, HYBRID_CANDIDATES),
				this.nearestChildrenForQuery(textQuery, provider, jobSignal),
			]);
			const fused = bestChunkPerFile(fuseChunks(fullText, vector, view.passes));
			const matches: AssetSearchItem[] = [];
			for (const { hit, score } of fused) {
				const asset = view.assetsById.get(hit.assetId);
				if (!asset) continue;
				matches.push({
					...toSearchItem(asset, view.propertiesOf(hit.assetId)),
					score,
					passage: hit.text,
					parentPassage: hit.parentText,
					chunkId: hit.chunkId,
				});
			}
			const ranked = await this.rerankMatches(textQuery, matches, rerank, jobSignal);
			return { kind: "asset_list", assets: ranked.slice(0, view.limit), total: ranked.length, indexedCount };
		}, signal);
	}

	/** Library listing, property lookup, and the type/property filter shared by both searches. */
	private async searchView(query: AssetSearchQuery) {
		const [assets, definitions, values, tags, assetTags, favoriteIds] = await Promise.all([
			this.metadataStore.listAssets(),
			this.metadataStore.listProperties(),
			this.metadataStore.listAllAssetProperties(),
			this.metadataStore.listTags(),
			this.metadataStore.listAssetTags(),
			this.metadataStore.listFavoriteIds(),
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
		const propertiesOf = (assetId: string) => propertiesByAsset.get(assetId) ?? [];
		const tagIdByName = new Map(tags.map((tag) => [tag.name.toLowerCase(), tag.tagId]));
		const tagIdsOf = new Map<string, Set<string>>();
		for (const link of assetTags) {
			const ids = tagIdsOf.get(link.assetId) ?? new Set<string>();
			ids.add(link.tagId);
			tagIdsOf.set(link.assetId, ids);
		}
		// Resolved once. A name that is not a tag yields undefined, which no file can have.
		const wantedTagIds = (query.tags ?? []).map((name) => tagIdByName.get(name.trim().toLowerCase()));
		const favorites = new Set(favoriteIds);
		const passes = (assetId: string): boolean => {
			const asset = assetsById.get(assetId);
			if (!asset) return false;
			if (query.type && asset.type !== query.type) return false;
			if (query.favorite !== undefined && favorites.has(assetId) !== query.favorite) return false;
			if (wantedTagIds.length > 0) {
				const have = tagIdsOf.get(assetId);
				if (!have || wantedTagIds.some((tagId) => tagId === undefined || !have.has(tagId))) return false;
			}
			return matchesPropertyFilters(propertiesOf(assetId), filters, definitionByName);
		};
		const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 20)));
		/** No query text: the filtered library in listing order. */
		const list = (): AssetSearchResult => {
			const matches = assets
				.filter((asset) => passes(asset.assetId))
				.map((asset) => toSearchItem(asset, propertiesOf(asset.assetId)));
			return { kind: "asset_list", assets: matches.slice(0, limit), total: matches.length };
		};
		return { assetsById, propertiesOf, passes, limit, list };
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
			const scores = await abortableProviderCall(() => rerank.rerank(query, documents, signal), signal);
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
	): Promise<ChunkHit[]> {
		if (!provider) return [];
		try {
			const [vector] = await abortableProviderCall(() => provider.embed([text], signal), signal);
			if (!vector?.length) return [];
			return this.metadataStore.searchNearestChildren(vector, HYBRID_CANDIDATES);
		} catch (error) {
			if (signal?.aborted) throw error;
			return [];
		}
	}

	async inspectAsset(assetId: string): Promise<AssetDetailResult> {
		return this.runLibraryTask(async () => {
			const asset = await this.metadataStore.getAsset(assetId);
			if (!asset) throw new Error("Asset not found");
			const [definitions, values, tags, assetTags, favoriteIds] = await Promise.all([
				this.metadataStore.listProperties(),
				this.metadataStore.listAssetProperties(assetId),
				this.metadataStore.listTags(),
				this.metadataStore.listAssetTags(),
				this.metadataStore.listFavoriteIds(),
			]);
			const tagNames = new Map(tags.map((tag) => [tag.tagId, tag.name]));
			const tagsOnAsset = assetTags
				.filter((link) => link.assetId === assetId)
				.flatMap((link) => tagNames.get(link.tagId) ?? []);
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
				tags: tagsOnAsset,
				favorite: favoriteIds.includes(assetId),
				previewRef: `loom-asset://asset/${encodeURIComponent(asset.assetId)}?v=${asset.modifiedAt}`,
				enrichment: await this.metadataStore.getAssetEnrichment(asset.assetId),
				textEmbed: await this.textEmbed.getStatus(asset.assetId),
				imageVlm: await this.imageVlm.getStatus(asset.assetId),
				videoVlm: await this.videoVlm.getStatus(asset.assetId),
				audioWriteup: await this.audioWriteup.getStatus(asset.assetId),
				...await this.listAssetRelations(asset.assetId),
			};
		});
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
		const links: AssetLinkView[] = [];
		for (const relation of relations) {
			const outgoing = relation.fromAssetId === assetId;
			const otherId = outgoing ? relation.toAssetId : relation.fromAssetId;
			const other = await this.metadataStore.getAsset(otherId);
			if (!other) continue;
			links.push({
				relationId: relation.relationId,
				relationType: relation.type,
				direction: outgoing ? "out" : "in",
				asset: toRelationView(other),
			});
		}
		links.sort((a, b) => (
			a.relationType.localeCompare(b.relationType)
			|| a.direction.localeCompare(b.direction)
			|| compareRelationView(a.asset, b.asset)
		));
		return { links };
	}

	getAssetEnrichment(assetId: string): Promise<AssetEnrichment | undefined> {
		return this.metadataStore.getAssetEnrichment(assetId);
	}

	getTextEmbedStatus(assetId: string, currentModelId?: string): Promise<TextEmbedStatus> {
		return this.runLibraryTask(() => this.textEmbed.getStatus(assetId, currentModelId));
	}

	async embedTextAsset(
		assetId: string,
		provider: EmbeddingProvider,
		signal?: AbortSignal,
		options?: EmbedOptions,
	): Promise<TextEmbedStatus> {
		const tasks = this.tasks;
		return this.runLibraryTask(async (jobSignal) => {
			const notify = () => { if (tasks?.active && this.tasks === tasks) this.library.notifyTextEmbed(assetId); };
			const status = await this.textEmbed.embed(assetId, provider, notify, jobSignal, options);
			notify();
			return status;
		}, signal);
	}

	getImageVlmStatus(assetId: string, currentModelId?: string): Promise<ImageVlmStatus> {
		return this.runLibraryTask(() => this.imageVlm.getStatus(assetId, currentModelId));
	}

	async describeImageAsset(
		assetId: string,
		provider: ImageVlmProvider,
		signal?: AbortSignal,
		options?: DescribeOptions,
	): Promise<ImageVlmStatus> {
		const tasks = this.tasks;
		return this.runLibraryTask(async (jobSignal) => {
			const notify = () => { if (tasks?.active && this.tasks === tasks) this.library.notifyImageVlm(assetId); };
			return this.imageVlm.describe(assetId, provider, notify, jobSignal, options);
		}, signal);
	}

	getVideoVlmStatus(assetId: string, currentModelId?: string): Promise<VideoVlmStatus> {
		return this.runLibraryTask(() => this.videoVlm.getStatus(assetId, currentModelId));
	}

	async describeVideoAsset(
		assetId: string,
		provider: VideoVlmProvider,
		signal?: AbortSignal,
		options?: DescribeOptions,
	): Promise<VideoVlmStatus> {
		const tasks = this.tasks;
		return this.runLibraryTask(async (jobSignal) => {
			const notify = () => { if (tasks?.active && this.tasks === tasks) this.library.notifyVideoVlm(assetId); };
			return this.videoVlm.describe(assetId, provider, notify, jobSignal, options);
		}, signal);
	}

	getAudioWriteupStatus(assetId: string, currentModelId?: string): Promise<AudioWriteupStatus> {
		return this.runLibraryTask(() => this.audioWriteup.getStatus(assetId, currentModelId));
	}

	async describeAudioAsset(
		assetId: string,
		provider: AudioWriteupProvider,
		signal?: AbortSignal,
		options?: DescribeOptions,
	): Promise<AudioWriteupStatus> {
		const tasks = this.tasks;
		return this.runLibraryTask(async (jobSignal) => {
			const notify = () => { if (tasks?.active && this.tasks === tasks) this.library.notifyAudioWriteup(assetId); };
			return this.audioWriteup.describe(assetId, provider, notify, jobSignal, options);
		}, signal);
	}

	refreshEnrichment(assets: Asset[]): Promise<AssetEnrichment[]> {
		return this.runLibraryTask((signal) => this.enrichment.refreshStale(assets, signal));
	}

	getMediaInfo(path: string, signal?: AbortSignal): Promise<MediaInfoResult> {
		return this.runLibraryTask((jobSignal) => this.media.getMediaInfo(path, jobSignal), signal);
	}

	async gradeImage(args: GradeImageArgs, signal?: AbortSignal): Promise<GradeImageResult> {
		return this.runLibraryTask(async (jobSignal) => {
			const job = await this.media.gradeImage(args, jobSignal);
			const asset = await this.library.indexFile(job.output);
			if (!asset) throw new Error("Could not index graded image");
			const source = await this.metadataStore.getAssetByPath(job.input);
			return {
				kind: "grade_image",
				output: job.output,
				assetId: asset.assetId,
				sourceAssetId: source?.assetId,
			};
		}, signal);
	}

	async gradeVideo(args: GradeVideoArgs, signal?: AbortSignal): Promise<GradeVideoResult> {
		return this.runLibraryTask(async (jobSignal) => {
			const job = await this.media.gradeVideo(args, jobSignal);
			const asset = await this.library.indexFile(job.output);
			if (!asset) throw new Error("Could not index graded video");
			const source = await this.metadataStore.getAssetByPath(job.input);
			return {
				kind: "grade_video",
				output: job.output,
				assetId: asset.assetId,
				sourceAssetId: source?.assetId,
			};
		}, signal);
	}

	async getVideoGradeInfo(assetId: string): Promise<{ duration: number }> {
		return this.runLibraryTask(async (signal) => {
			const asset = await this.metadataStore.getAsset(assetId);
			if (!asset) throw new Error("Asset not found");
			if (!isGradeableVideo(asset.relativePath)) throw new TypeError("Grade supports MP4, MOV, MKV, WebM, M4V, and AVI");
			const info = await this.media.getMediaInfo(asset.relativePath, signal);
			return { duration: info.duration ?? 0 };
		});
	}

	async previewVideoGrade(
		assetId: string,
		timeSeconds: number,
		grade: unknown,
		lut?: string,
		force = false,
		signal?: AbortSignal,
	): Promise<string | null> {
		return this.runLibraryTask(async (jobSignal) => {
			const asset = await this.metadataStore.getAsset(assetId);
			if (!asset) throw new Error("Asset not found");
			const bytes = await this.media.previewVideoGrade({
				path: asset.relativePath,
				timeSeconds,
				grade,
				lut,
			}, jobSignal, force);
			return bytes ? bytes.toString("base64") : null;
		}, signal);
	}

	async previewImageGrade(
		assetId: string,
		grade: unknown,
		lut?: string,
		force = false,
		signal?: AbortSignal,
	): Promise<string | null> {
		return this.runLibraryTask(async (jobSignal) => {
			const asset = await this.metadataStore.getAsset(assetId);
			if (!asset) throw new Error("Asset not found");
			const bytes = await this.media.previewImageGrade({
				path: asset.relativePath,
				grade,
				lut,
			}, jobSignal, force);
			return bytes ? bytes.toString("base64") : null;
		}, signal);
	}

	async importGradeLut(absolutePath: string): Promise<{ path: string; name: string }> {
		const paths = this.library.getPaths();
		const text = await readFile(absolutePath, "utf8");
		if (!/LUT_3D_SIZE\s+\d+/i.test(text)) throw new Error("Not a 3D .cube LUT");
		try {
			const path = paths.toRelativePath(absolutePath);
			return { path, name: basename(path) };
		} catch (error) {
			if (!(error instanceof Error) || !error.message.startsWith("Path is outside the library")) throw error;
		}
		const dir = paths.gradeLuts;
		await mkdir(dir, { recursive: true });
		const filename = await unusedLutFilename(dir, basename(absolutePath));
		const dest = join(dir, filename);
		await copyFile(absolutePath, dest);
		const path = paths.toRelativePath(dest);
		return { path, name: basename(path) };
	}

	runFfmpeg(args: RunFfmpegArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		return this.runLibraryTask((jobSignal) => this.media.runFfmpeg(args, jobSignal), signal);
	}

	runFfprobe(args: RunFfprobeArgs, signal?: AbortSignal): Promise<MediaJobResult> {
		return this.runLibraryTask((jobSignal) => this.media.runFfprobe(args, jobSignal), signal);
	}

	subscribeLibrary(listener: (change: LibraryChange) => void): () => void {
		return this.library.subscribe(listener);
	}

	close(): Promise<void> {
		return this.changeLibrary(() => this.closeCurrentLibrary());
	}
}

async function unusedLutFilename(dir: string, originalName: string): Promise<string> {
	const cleaned = basename(originalName).replace(/[\\/:*?"<>|\0]+/g, "-").replace(/^\.+/, "") || "look.cube";
	const stem = cleaned.replace(/\.cube$/i, "") || "look";
	for (let copy = 1; copy < 1000; copy += 1) {
		const filename = `${stem}${copy === 1 ? "" : `-${copy}`}.cube`;
		try {
			await access(join(dir, filename));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return filename;
			throw error;
		}
	}
	return `${stem}-${randomUUID()}.cube`;
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

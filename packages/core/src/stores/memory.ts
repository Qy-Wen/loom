import { randomUUID } from "node:crypto";
import type { Asset } from "../model/asset.ts";
import { normalizeTagName, tagNameKey, type AssetTag, type Tag } from "../model/tag.ts";
import type { AssetEnrichment } from "../model/enrichment.ts";
import {
	assertPropertyDefinition,
	assertPropertyValue,
	type AssetPropertyValue,
	type PropertyDefinition,
} from "../model/property.ts";
import type { ImageVlmRecord } from "../model/image-vlm.ts";
import type { VideoVlmRecord } from "../model/video-vlm.ts";
import type { AudioWriteupRecord } from "../model/audio-writeup.ts";
import type {
	StoredTextChunk,
	TextEmbedJob,
} from "../model/text-embed.ts";
import type { ChunkHit } from "../model/hybrid.ts";
import { cosineDistance } from "../retrieval/rrf.ts";
import { searchDocument } from "../retrieval/text.ts";
import { documentMatchesQuery } from "../retrieval/tokenize.ts";
import type { AssetRelation } from "../model/relation.ts";
import type { GraphStore, MetadataStore } from "./types.ts";

/** Volatile MetadataStore used by focused tests and explicit dependency injection. */
export class InMemoryMetadataStore implements MetadataStore {
	private readonly assets = new Map<string, Asset>();
	private readonly assetIdByPath = new Map<string, string>();
	private readonly assetIdByFileSystemId = new Map<string, string>();
	private readonly properties = new Map<string, PropertyDefinition>();
	private readonly propertyIdByName = new Map<string, string>();
	private readonly assetProperties = new Map<string, Map<string, AssetPropertyValue>>();
	private readonly enrichments = new Map<string, AssetEnrichment>();
	private readonly textEmbedJobs = new Map<string, TextEmbedJob>();
	private readonly textChunks = new Map<string, StoredTextChunk[]>();
	private readonly imageVlm = new Map<string, ImageVlmRecord>();
	private readonly videoVlm = new Map<string, VideoVlmRecord>();
	private readonly audioWriteup = new Map<string, AudioWriteupRecord>();
	private volumeId: string | undefined;
	private readonly favorites = new Map<string, number>();
	private readonly tags = new Map<string, Tag>();
	private readonly tagIdByName = new Map<string, string>();
	private readonly assetTags = new Map<string, Map<string, number>>();

	async open(): Promise<void> {
		this.assets.clear();
		this.assetIdByPath.clear();
		this.assetIdByFileSystemId.clear();
		this.properties.clear();
		this.propertyIdByName.clear();
		this.assetProperties.clear();
		this.enrichments.clear();
		this.textEmbedJobs.clear();
		this.textChunks.clear();
		this.imageVlm.clear();
		this.videoVlm.clear();
		this.audioWriteup.clear();
		this.favorites.clear();
		this.tags.clear();
		this.tagIdByName.clear();
		this.assetTags.clear();
		this.volumeId = undefined;
	}

	async close(): Promise<void> {
		this.assets.clear();
		this.assetIdByPath.clear();
		this.assetIdByFileSystemId.clear();
		this.properties.clear();
		this.propertyIdByName.clear();
		this.assetProperties.clear();
		this.enrichments.clear();
		this.textEmbedJobs.clear();
		this.textChunks.clear();
		this.imageVlm.clear();
		this.videoVlm.clear();
		this.audioWriteup.clear();
		this.favorites.clear();
		this.tags.clear();
		this.tagIdByName.clear();
		this.assetTags.clear();
		this.volumeId = undefined;
	}

	async upsertAsset(asset: Asset): Promise<void> {
		const previous = this.assets.get(asset.assetId);
		if (previous && previous.relativePath !== asset.relativePath) {
			this.assetIdByPath.delete(previous.relativePath);
		}
		if (previous?.fileSystemId && previous.fileSystemId !== asset.fileSystemId) {
			this.assetIdByFileSystemId.delete(previous.fileSystemId);
		}

		const replacedId = this.assetIdByPath.get(asset.relativePath);
		if (replacedId && replacedId !== asset.assetId) {
			const replaced = this.assets.get(replacedId);
			this.assets.delete(replacedId);
			if (replaced?.fileSystemId) this.assetIdByFileSystemId.delete(replaced.fileSystemId);
			this.enrichments.delete(replacedId);
			this.imageVlm.delete(replacedId);
			this.videoVlm.delete(replacedId);
			this.audioWriteup.delete(replacedId);
			this.clearTextIndex(replacedId);
		}

		this.assets.set(asset.assetId, asset);
		this.assetIdByPath.set(asset.relativePath, asset.assetId);
		if (asset.fileSystemId) this.assetIdByFileSystemId.set(asset.fileSystemId, asset.assetId);
	}

	async getAsset(assetId: string): Promise<Asset | undefined> {
		return this.assets.get(assetId);
	}

	async getAssetByPath(relativePath: string): Promise<Asset | undefined> {
		const assetId = this.assetIdByPath.get(relativePath);
		return assetId ? this.assets.get(assetId) : undefined;
	}

	async getAssetByFileSystemId(fileSystemId: string): Promise<Asset | undefined> {
		const assetId = this.assetIdByFileSystemId.get(fileSystemId);
		return assetId ? this.assets.get(assetId) : undefined;
	}

	async listAssets(): Promise<Asset[]> {
		return [...this.assets.values()].sort((a, b) =>
			a.relativePath.localeCompare(b.relativePath),
		);
	}

	async replaceAssets(assets: Asset[]): Promise<void> {
		const nextAssetIds = new Set(assets.map((asset) => asset.assetId));
		this.assets.clear();
		this.assetIdByPath.clear();
		this.assetIdByFileSystemId.clear();
		for (const asset of assets) {
			this.assets.set(asset.assetId, asset);
			this.assetIdByPath.set(asset.relativePath, asset.assetId);
			if (asset.fileSystemId) this.assetIdByFileSystemId.set(asset.fileSystemId, asset.assetId);
		}
		for (const assetId of this.assetProperties.keys()) {
			if (!nextAssetIds.has(assetId)) this.assetProperties.delete(assetId);
		}
		for (const assetId of this.enrichments.keys()) {
			if (!nextAssetIds.has(assetId)) this.enrichments.delete(assetId);
		}
		for (const assetId of this.textEmbedJobs.keys()) {
			if (!nextAssetIds.has(assetId)) this.clearTextIndex(assetId);
		}
		for (const assetId of this.textChunks.keys()) {
			if (!nextAssetIds.has(assetId)) this.clearTextIndex(assetId);
		}
		for (const assetId of this.imageVlm.keys()) {
			if (!nextAssetIds.has(assetId)) this.imageVlm.delete(assetId);
		}
		for (const assetId of this.videoVlm.keys()) {
			if (!nextAssetIds.has(assetId)) this.videoVlm.delete(assetId);
		}
		for (const assetId of this.audioWriteup.keys()) {
			if (!nextAssetIds.has(assetId)) this.audioWriteup.delete(assetId);
		}
		for (const assetId of this.favorites.keys()) {
			if (!nextAssetIds.has(assetId)) this.favorites.delete(assetId);
		}
		for (const assetId of this.assetTags.keys()) {
			if (!nextAssetIds.has(assetId)) this.assetTags.delete(assetId);
		}
		this.dropUnusedTags();
	}

	async removeAsset(assetId: string): Promise<void> {
		const asset = this.assets.get(assetId);
		if (!asset) return;
		this.assets.delete(assetId);
		this.assetIdByPath.delete(asset.relativePath);
		if (asset.fileSystemId) this.assetIdByFileSystemId.delete(asset.fileSystemId);
		this.assetProperties.delete(assetId);
		this.enrichments.delete(assetId);
		this.imageVlm.delete(assetId);
		this.videoVlm.delete(assetId);
		this.audioWriteup.delete(assetId);
		this.favorites.delete(assetId);
		this.assetTags.delete(assetId);
		this.dropUnusedTags();
		this.clearTextIndex(assetId);
	}

	async listFavoriteIds(): Promise<string[]> {
		return [...this.favorites.entries()]
			.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
			.map(([assetId]) => assetId);
	}

	async setFavorite(assetId: string, favorite: boolean): Promise<void> {
		if (!this.assets.has(assetId)) throw new Error("Asset not found");
		if (favorite) {
			const latest = Math.max(0, ...this.favorites.values());
			this.favorites.set(assetId, Math.max(Date.now(), latest + 1));
		}
		else this.favorites.delete(assetId);
	}

	async listTags(): Promise<Tag[]> {
		return [...this.tags.values()].sort((left, right) => left.name.localeCompare(right.name) || left.tagId.localeCompare(right.tagId));
	}

	async listAssetTags(): Promise<AssetTag[]> {
		const rows: AssetTag[] = [];
		for (const [assetId, links] of this.assetTags) {
			for (const [tagId, createdAt] of links) rows.push({ assetId, tagId, createdAt });
		}
		rows.sort((left, right) => left.createdAt - right.createdAt || left.assetId.localeCompare(right.assetId) || left.tagId.localeCompare(right.tagId));
		return rows;
	}

	async addAssetTag(assetId: string, name: string): Promise<void> {
		if (!this.assets.has(assetId)) throw new Error("Asset not found");
		const display = normalizeTagName(name);
		const key = tagNameKey(display);
		let tagId = this.tagIdByName.get(key);
		if (!tagId) {
			tagId = randomUUID();
			const tag = { tagId, name: display };
			this.tags.set(tagId, tag);
			this.tagIdByName.set(key, tagId);
		}
		const links = this.assetTags.get(assetId) ?? new Map<string, number>();
		if (links.has(tagId)) return;
		const latest = Math.max(0, ...links.values());
		links.set(tagId, Math.max(Date.now(), latest + 1));
		this.assetTags.set(assetId, links);
	}

	async removeAssetTag(assetId: string, tagId: string): Promise<void> {
		const links = this.assetTags.get(assetId);
		links?.delete(tagId);
		if (links && links.size === 0) this.assetTags.delete(assetId);
		this.dropUnusedTags();
	}

	private dropUnusedTags(): void {
		const used = new Set<string>();
		for (const links of this.assetTags.values()) {
			for (const tagId of links.keys()) used.add(tagId);
		}
		for (const [tagId, tag] of this.tags) {
			if (used.has(tagId)) continue;
			this.tags.delete(tagId);
			this.tagIdByName.delete(tagNameKey(tag.name));
		}
	}

	async getLibraryVolumeId(): Promise<string | undefined> {
		return this.volumeId;
	}

	async setLibraryVolumeId(volumeId: string): Promise<void> {
		this.volumeId = volumeId;
	}

	async createProperty(property: PropertyDefinition): Promise<void> {
		assertPropertyDefinition(property);
		if (this.properties.has(property.propertyId)) throw new Error("Property already exists");
		const nameKey = normalizePropertyName(property.name);
		if (this.propertyIdByName.has(nameKey)) throw new Error("Property name already exists");
		this.properties.set(property.propertyId, property);
		this.propertyIdByName.set(nameKey, property.propertyId);
	}

	async updateProperty(property: PropertyDefinition): Promise<void> {
		assertPropertyDefinition(property);
		const previous = this.properties.get(property.propertyId);
		if (!previous) throw new Error("Property not found");
		const nameKey = normalizePropertyName(property.name);
		const nameOwner = this.propertyIdByName.get(nameKey);
		if (nameOwner && nameOwner !== property.propertyId) throw new Error("Property name already exists");
		if (previous.type !== property.type && this.hasValuesForProperty(property.propertyId)) {
			throw new Error("Cannot change the type of a property that has values");
		}
		this.propertyIdByName.delete(normalizePropertyName(previous.name));
		this.properties.set(property.propertyId, { ...property, createdAt: previous.createdAt });
		this.propertyIdByName.set(nameKey, property.propertyId);
	}

	async getProperty(propertyId: string): Promise<PropertyDefinition | undefined> {
		return this.properties.get(propertyId);
	}

	async listProperties(): Promise<PropertyDefinition[]> {
		return [...this.properties.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	async removeProperty(propertyId: string): Promise<void> {
		const property = this.properties.get(propertyId);
		if (!property) return;
		this.properties.delete(propertyId);
		this.propertyIdByName.delete(normalizePropertyName(property.name));
		for (const values of this.assetProperties.values()) values.delete(propertyId);
	}

	async setAssetProperty(value: AssetPropertyValue): Promise<void> {
		if (!this.assets.has(value.assetId)) throw new Error("Asset not found");
		const property = this.properties.get(value.propertyId);
		if (!property) throw new Error("Property not found");
		assertPropertyValue(property.type, value.value);
		let values = this.assetProperties.get(value.assetId);
		if (!values) {
			values = new Map();
			this.assetProperties.set(value.assetId, values);
		}
		values.set(value.propertyId, value);
	}

	async listAssetProperties(assetId: string): Promise<AssetPropertyValue[]> {
		return [...(this.assetProperties.get(assetId)?.values() ?? [])].sort((a, b) =>
			a.propertyId.localeCompare(b.propertyId),
		);
	}

	async listAllAssetProperties(): Promise<AssetPropertyValue[]> {
		return [...this.assetProperties.values()]
			.flatMap((values) => [...values.values()])
			.sort((a, b) => a.assetId.localeCompare(b.assetId) || a.propertyId.localeCompare(b.propertyId));
	}

	async removeAssetProperty(assetId: string, propertyId: string): Promise<void> {
		this.assetProperties.get(assetId)?.delete(propertyId);
	}

	async getAssetEnrichment(assetId: string): Promise<AssetEnrichment | undefined> {
		return this.enrichments.get(assetId);
	}

	async listAssetEnrichments(): Promise<AssetEnrichment[]> {
		return [...this.enrichments.values()];
	}

	async upsertAssetEnrichment(record: AssetEnrichment): Promise<void> {
		if (!this.assets.has(record.assetId)) throw new Error("Asset not found");
		this.enrichments.set(record.assetId, record);
	}

	async recoverInterruptedJobs(): Promise<void> {
		for (const records of [this.textEmbedJobs, this.imageVlm, this.videoVlm, this.audioWriteup]) {
			for (const record of records.values()) {
				if (record.status !== "embedding" && record.status !== "describing") continue;
				record.status = "failed";
				record.error = "Library operation interrupted; retry to continue";
				record.updatedAt = Date.now();
			}
		}
	}

	async getTextEmbedJob(assetId: string): Promise<TextEmbedJob | undefined> {
		return this.textEmbedJobs.get(assetId);
	}

	async upsertTextEmbedJob(job: TextEmbedJob): Promise<void> {
		if (!this.assets.has(job.assetId)) throw new Error("Asset not found");
		this.textEmbedJobs.set(job.assetId, job);
	}

	async replaceTextChunks(assetId: string, chunks: StoredTextChunk[]): Promise<void> {
		if (!this.assets.has(assetId)) throw new Error("Asset not found");
		this.textChunks.set(assetId, chunks.map(cloneChunk));
	}

	async listTextChunks(assetId: string): Promise<StoredTextChunk[]> {
		return (this.textChunks.get(assetId) ?? []).map(cloneChunk);
	}

	async getImageVlm(assetId: string): Promise<ImageVlmRecord | undefined> {
		return this.imageVlm.get(assetId);
	}

	async upsertImageVlm(record: ImageVlmRecord): Promise<void> {
		if (!this.assets.has(record.assetId)) throw new Error("Asset not found");
		this.imageVlm.set(record.assetId, record);
	}

	async getVideoVlm(assetId: string): Promise<VideoVlmRecord | undefined> {
		return this.videoVlm.get(assetId);
	}

	async upsertVideoVlm(record: VideoVlmRecord): Promise<void> {
		if (!this.assets.has(record.assetId)) throw new Error("Asset not found");
		this.videoVlm.set(record.assetId, record);
	}

	async getAudioWriteup(assetId: string): Promise<AudioWriteupRecord | undefined> {
		return this.audioWriteup.get(assetId);
	}

	async upsertAudioWriteup(record: AudioWriteupRecord): Promise<void> {
		if (!this.assets.has(record.assetId)) throw new Error("Asset not found");
		this.audioWriteup.set(record.assetId, record);
	}

	async searchAssetIds(query: string): Promise<string[]> {
		const matches: Array<{ assetId: string; path: string }> = [];
		for (const asset of this.assets.values()) {
			const values = [...(this.assetProperties.get(asset.assetId)?.values() ?? [])].map((item) => item.value);
			const document = searchDocument(
				asset.filename,
				asset.relativePath,
				values,
				this.enrichments.get(asset.assetId),
				readyVlmText(
					this.imageVlm.get(asset.assetId),
					this.videoVlm.get(asset.assetId),
					this.audioWriteup.get(asset.assetId),
				),
			);
			if (!documentMatchesQuery(document, query)) continue;
			matches.push({ assetId: asset.assetId, path: asset.relativePath });
		}
		matches.sort((left, right) => left.path.localeCompare(right.path));
		return matches.map((item) => item.assetId);
	}

	async searchNearestChildren(vector: number[], limit: number): Promise<ChunkHit[]> {
		const cap = Math.max(0, Math.trunc(limit));
		if (cap === 0 || vector.length === 0) return [];
		const hits: Array<ChunkHit & { distance: number }> = [];
		for (const chunks of this.textChunks.values()) {
			const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
			for (const chunk of chunks) {
				if (chunk.role !== "child" || !chunk.embedding || chunk.embedding.length !== vector.length) continue;
				const parent = chunk.parentId ? byId.get(chunk.parentId) : undefined;
				hits.push({
					chunkId: chunk.chunkId,
					assetId: chunk.assetId,
					parentId: chunk.parentId,
					text: chunk.text,
					parentText: parent?.text,
					distance: cosineDistance(vector, chunk.embedding),
				});
			}
		}
		hits.sort((left, right) => left.distance - right.distance || left.chunkId.localeCompare(right.chunkId));
		return hits.slice(0, cap).map(({ distance: _distance, ...hit }) => hit);
	}

	/** Same match as the SQLite index; there is no bm25 here, so hits come in a stable order. */
	async searchChunksFts(query: string, limit: number): Promise<ChunkHit[]> {
		const cap = Math.max(0, Math.trunc(limit));
		if (cap === 0) return [];
		const hits: ChunkHit[] = [];
		for (const chunks of this.textChunks.values()) {
			const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
			for (const chunk of chunks) {
				if (chunk.role !== "child" || !documentMatchesQuery(chunk.text, query)) continue;
				const parent = chunk.parentId ? byId.get(chunk.parentId) : undefined;
				hits.push({
					chunkId: chunk.chunkId,
					assetId: chunk.assetId,
					parentId: chunk.parentId,
					text: chunk.text,
					parentText: parent?.text,
				});
			}
		}
		hits.sort((left, right) => left.chunkId.localeCompare(right.chunkId));
		return hits.slice(0, cap);
	}

	private hasValuesForProperty(propertyId: string): boolean {
		for (const values of this.assetProperties.values()) {
			if (values.has(propertyId)) return true;
		}
		return false;
	}

	private clearTextIndex(assetId: string): void {
		this.textEmbedJobs.delete(assetId);
		this.textChunks.delete(assetId);
	}

}

function cloneChunk(chunk: StoredTextChunk): StoredTextChunk {
	return {
		...chunk,
		embedding: chunk.embedding ? [...chunk.embedding] : undefined,
	};
}

function readyVlmText(
	image: ImageVlmRecord | undefined,
	video: VideoVlmRecord | undefined,
	audio: AudioWriteupRecord | undefined,
): string | undefined {
	if (image?.status === "ready") return image.markdown;
	if (video?.status === "ready") return video.markdown;
	if (audio?.status === "ready") return audio.markdown;
	return undefined;
}

function normalizePropertyName(name: string): string {
	return name.trim().toLowerCase();
}

/** Volatile GraphStore used by focused tests and explicit dependency injection. */
export class InMemoryGraphStore implements GraphStore {
	private readonly relations = new Map<string, AssetRelation>();

	async open(): Promise<void> {
		this.relations.clear();
	}

	async close(): Promise<void> {
		this.relations.clear();
	}

	async ensureAsset(): Promise<void> {}

	async removeAsset(assetId: string): Promise<void> {
		for (const [relationId, relation] of this.relations) {
			if (relation.fromAssetId === assetId || relation.toAssetId === assetId) {
				this.relations.delete(relationId);
			}
		}
	}

	async upsertRelation(relation: AssetRelation): Promise<void> {
		for (const [relationId, existing] of this.relations) {
			if (
				existing.fromAssetId === relation.fromAssetId &&
				existing.toAssetId === relation.toAssetId &&
				existing.type === relation.type
			) {
				this.relations.delete(relationId);
			}
		}
		this.relations.set(relation.relationId, relation);
	}

	async listRelations(assetId: string): Promise<AssetRelation[]> {
		return [...this.relations.values()]
			.filter((relation) => relation.fromAssetId === assetId || relation.toAssetId === assetId)
			.sort((a, b) => a.type.localeCompare(b.type) || a.relationId.localeCompare(b.relationId));
	}

	async listAllRelations(): Promise<AssetRelation[]> {
		return [...this.relations.values()]
			.sort((a, b) => a.type.localeCompare(b.type) || a.relationId.localeCompare(b.relationId));
	}

	async removeRelation(relationId: string): Promise<void> {
		this.relations.delete(relationId);
	}
}

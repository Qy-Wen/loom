import { Fragment, useEffect, useState } from "react";
import type {
	Asset,
	AssetEnrichment,
	AssetLinkView,
	AssetPropertyValue,
	AssetRelationsResult,
	AssetTag,
	PropertyDefinition,
	Tag,
	TextEmbedStatus,
	ImageVlmStatus,
	VideoVlmStatus,
	AudioWriteupStatus,
} from "@loom/core";
import { formatBytes } from "../assets/asset-utils.ts";
import { assetTypeLabel } from "../../shared/locale.ts";
import { useLocale } from "../locale.tsx";
import { displayPropertyValue } from "../workbench/table-values.ts";
import { EnrichmentDetails } from "./enrichment-details.tsx";
import { MediaDescriptionDetails } from "./media-description-details.tsx";
import { TextEmbedDetails } from "./text-embed-details.tsx";
import { SuggestInput } from "../components/suggest-input.tsx";
import { TagEditor } from "./tag-editor.tsx";

interface DetailsPanelProps {
	asset: Asset | null;
	properties: PropertyDefinition[];
	propertyValues: AssetPropertyValue[];
	tags: Tag[];
	assetTags: AssetTag[];
	onAddTag: (assetId: string, name: string) => Promise<void>;
	onRemoveTag: (assetId: string, tagId: string) => Promise<void>;
	enrichment: AssetEnrichment | undefined;
	textEmbed: TextEmbedStatus | undefined;
	embedding: boolean;
	onEmbed: (force?: boolean) => void;
	imageVlm: ImageVlmStatus | undefined;
	videoVlm: VideoVlmStatus | undefined;
	audioWriteup: AudioWriteupStatus | undefined;
	describing: boolean;
	onDescribe: () => void;
	relations: AssetRelationsResult;
	assets: Asset[];
	relationTypes: string[];
	onSelectAsset: (assetId: string) => void;
	onCreateRelation: (fromAssetId: string, toAssetId: string, type: string) => Promise<void>;
	onRemoveRelation: (relationId: string) => Promise<void>;
}

export function DetailsPanel({
	asset,
	properties,
	propertyValues,
	tags,
	assetTags,
	onAddTag,
	onRemoveTag,
	enrichment,
	textEmbed,
	embedding,
	onEmbed,
	imageVlm,
	videoVlm,
	audioWriteup,
	describing,
	onDescribe,
	relations,
	assets,
	relationTypes,
	onSelectAsset,
	onCreateRelation,
	onRemoveRelation,
}: DetailsPanelProps): React.JSX.Element {
	const { t } = useLocale();
	const describer = imageVlm?.supported ? imageVlm : videoVlm?.supported ? videoVlm : audioWriteup;
	return (
		<div className="side-panel">
			<div className="panel-content details-content thin-scroll active">
				<section>
					<div className="section-label">{t.details.file}</div>
					{asset ? (
						<dl className="properties">
							<dt>{t.details.type}</dt><dd>{assetTypeLabel(t, asset.type)}</dd>
							<dt>{t.details.size}</dt><dd>{formatBytes(asset.size)}</dd>
							<dt>{t.details.modified}</dt><dd>{new Date(asset.modifiedAt).toLocaleString()}</dd>
							<dt>{t.details.assetId}</dt><dd title={asset.assetId}>{asset.assetId}</dd>
							<EnrichmentDetails enrichment={enrichment} />
							<PropertySummary
								assetId={asset.assetId}
								properties={properties}
								propertyValues={propertyValues}
							/>
						</dl>
					) : (
						<div className="empty no-padding">{t.details.selectAsset}</div>
					)}
				</section>
				{asset && (
					<section>
						<TagEditor
							assetId={asset.assetId}
							tags={tags}
							assetTags={assetTags}
							onAdd={(name) => onAddTag(asset.assetId, name)}
							onRemove={(tagId) => onRemoveTag(asset.assetId, tagId)}
						/>
					</section>
				)}
				{asset && (describer?.supported ? (
					<MediaDescriptionDetails
						status={describer}
						textEmbed={textEmbed}
						busy={describing}
						embedding={embedding}
						onDescribe={onDescribe}
						onEmbed={onEmbed}
					/>
				) : (
					<TextEmbedDetails
						status={textEmbed}
						embedding={embedding}
						onEmbed={onEmbed}
					/>
				))}
				<section className="relations-section">
					<RelationsEditor
						asset={asset}
						assets={assets}
						relations={relations}
						relationTypes={relationTypes}
						onSelect={onSelectAsset}
						onCreate={onCreateRelation}
						onRemove={onRemoveRelation}
					/>
				</section>
			</div>
		</div>
	);
}

function PropertySummary({
	assetId,
	properties,
	propertyValues,
}: {
	assetId: string;
	properties: PropertyDefinition[];
	propertyValues: AssetPropertyValue[];
}): React.JSX.Element | null {
	const values = new Map(
		propertyValues.filter((value) => value.assetId === assetId).map((value) => [value.propertyId, value.value]),
	);
	const filled = properties.filter((property) => values.has(property.propertyId));
	if (filled.length === 0) return null;
	return (
		<>
			{filled.map((property, index) => (
				<Fragment key={property.propertyId}>
					<dt className={index === 0 ? "file-property" : undefined}>{property.name}</dt>
					<dd className={index === 0 ? "file-property" : undefined}>{displayPropertyValue(values.get(property.propertyId), property.type)}</dd>
				</Fragment>
			))}
		</>
	);
}

function RelationsEditor({
	asset,
	assets,
	relations,
	relationTypes,
	onSelect,
	onCreate,
	onRemove,
}: {
	asset: Asset | null;
	assets: Asset[];
	relations: AssetRelationsResult;
	relationTypes: string[];
	onSelect: (assetId: string) => void;
	onCreate: (fromAssetId: string, toAssetId: string, type: string) => Promise<void>;
	onRemove: (relationId: string) => Promise<void>;
}): React.JSX.Element {
	const { t } = useLocale();
	const others = assets
		.filter((item) => item.assetId !== asset?.assetId)
		.sort((a, b) => a.filename.localeCompare(b.filename) || a.relativePath.localeCompare(b.relativePath));
	const relationGroups = groupLinks(relations.links);
	const [form, setForm] = useState<{ type: string; toAssetId: string; direction: "out" | "in" } | null>(null);
	const [typeOpen, setTypeOpen] = useState(false);
	const [assetQuery, setAssetQuery] = useState("");
	const [assetOpen, setAssetOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const assetQueryNormalized = assetQuery.trim().toLowerCase();
	const assetMatches = others.filter((item) => {
		if (!assetQueryNormalized) return true;
		return item.filename.toLowerCase().includes(assetQueryNormalized)
			|| item.relativePath.toLowerCase().includes(assetQueryNormalized);
	});
	const selectedAsset = others.find((item) => item.assetId === form?.toAssetId);

	useEffect(() => {
		setForm(null);
		setTypeOpen(false);
		setAssetQuery("");
		setAssetOpen(false);
		setError(null);
	}, [asset?.assetId]);

	async function submit(): Promise<void> {
		if (!asset || !form?.type.trim() || !form.toAssetId || saving) return;
		setSaving(true);
		setError(null);
		const fromAssetId = form.direction === "out" ? asset.assetId : form.toAssetId;
		const toAssetId = form.direction === "out" ? form.toAssetId : asset.assetId;
		try {
			await onCreate(fromAssetId, toAssetId, form.type);
			setForm(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<div className="property-heading">
				<div className="section-label">{t.details.relations}</div>
				{asset && others.length > 0 && (
					<button
						className="icon-button"
						type="button"
						aria-label={t.details.addRelation}
						title={t.details.addRelation}
						onClick={() => {
							setForm({ type: "", toAssetId: "", direction: "out" });
							setTypeOpen(false);
							setAssetQuery("");
							setAssetOpen(false);
							setError(null);
						}}
					>+</button>
				)}
			</div>
			{asset && form && (
				<div className="property-definition-form relation-form">
					<div className="relation-type-row">
						<SuggestInput
							autoFocus
							openOnFocus={false}
							value={form.type}
							open={typeOpen}
							suggestions={relationTypes}
							placeholder={t.details.relationshipType}
							showLabel={t.details.showTypes}
							hideLabel={t.details.hideTypes}
							onChange={(type) => setForm({ ...form, type })}
							onOpenChange={setTypeOpen}
						/>
						<button
							type="button"
							className="relation-direction"
							aria-label={form.direction === "out" ? t.details.pointsOut : t.details.pointsIn}
							onClick={() => setForm({ ...form, direction: form.direction === "out" ? "in" : "out" })}
						>{form.direction === "out" ? "→" : "←"}</button>
					</div>
					<div className="relation-asset-picker">
						<button
							type="button"
							className="relation-asset-toggle"
							aria-expanded={assetOpen}
							onClick={() => setAssetOpen((current) => !current)}
						>
							<span>{selectedAsset?.filename ?? t.details.chooseFile}</span>
						</button>
						{assetOpen && (
							<div className="relation-asset-menu">
								<input
									autoFocus
									placeholder={t.common.searchFiles}
									value={assetQuery}
									onChange={(event) => setAssetQuery(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Escape") setAssetOpen(false);
									}}
								/>
								<ul>
									{assetMatches.map((item) => (
										<li key={item.assetId}>
											<button
												type="button"
												className={item.assetId === form.toAssetId ? "selected" : undefined}
												title={item.relativePath}
												onClick={() => {
													setForm({ ...form, toAssetId: item.assetId });
													setAssetOpen(false);
													setAssetQuery("");
												}}
											>
												{item.filename}
											</button>
										</li>
									))}
								</ul>
								{assetMatches.length === 0 && <div className="empty no-padding">{t.common.noMatchingFiles}</div>}
							</div>
						)}
					</div>
					{error && <div className="relation-form-error">{error}</div>}
					<div className="property-form-actions">
						<button type="button" onClick={() => { setForm(null); setError(null); }}>{t.common.cancel}</button>
						<button
							type="button"
							disabled={!form.type.trim() || !form.toAssetId || saving}
							onClick={() => void submit()}
						>{saving ? t.details.adding : t.common.add}</button>
					</div>
				</div>
			)}
			{asset && relationGroups.length > 0 ? (
				relationGroups.map((group) => (
					<RelationGroup
						key={group.type}
						label={group.type}
						items={group.items}
						showDirection
						onSelect={onSelect}
						onRemove={onRemove}
					/>
				))
			) : (
				<div className="empty no-padding">{asset ? t.details.noRelations : t.details.selectForRelations}</div>
			)}
		</>
	);
}

function RelationGroup({
	label,
	items,
	showDirection,
	onSelect,
	onRemove,
}: {
	label: string;
	items: AssetLinkView[];
	showDirection?: boolean;
	onSelect: (assetId: string) => void;
	onRemove: (relationId: string) => Promise<void>;
}): React.JSX.Element | null {
	const { t } = useLocale();
	if (items.length === 0) return null;
	return (
		<div className="relation-group">
			<div className="relation-group-label">{label}</div>
			<ul className="relation-list">
				{items.map((item) => (
					<li key={item.relationId}>
						<button type="button" onClick={() => onSelect(item.asset.assetId)}>
							<span className="relation-filename">
								{showDirection ? `${item.direction === "out" ? "→" : "←"} ` : ""}
								{item.asset.filename}
							</span>
						</button>
						<button
							className="icon-button"
							type="button"
							title={t.details.removeRelation}
							onClick={() => void onRemove(item.relationId)}
						>×</button>
					</li>
				))}
			</ul>
		</div>
	);
}

function groupLinks(links: AssetLinkView[]): { type: string; items: AssetLinkView[] }[] {
	const groups = new Map<string, AssetLinkView[]>();
	for (const link of links) {
		const items = groups.get(link.relationType) ?? [];
		items.push(link);
		groups.set(link.relationType, items);
	}
	return [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([type, items]) => ({ type, items }));
}

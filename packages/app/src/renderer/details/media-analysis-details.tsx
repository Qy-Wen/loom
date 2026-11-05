import { useState } from "react";
import type { AudioWriteupStatus, ImageVlmStatus, TextEmbedStatus, VideoVlmStatus } from "@loom/core";
import { useLocale } from "../locale.tsx";
import { useConfirmation } from "../components/confirm-dialog.tsx";
import { MediaDescriptionDetails } from "./media-description-details.tsx";
import { TextEmbedDetails } from "./text-embed-details.tsx";
import { TagActionIcon } from "../components/tag-icon.tsx";

interface MediaAnalysisDetailsProps {
	status: ImageVlmStatus | VideoVlmStatus | AudioWriteupStatus;
	textEmbed: TextEmbedStatus | undefined;
	describing: boolean;
	embedding: boolean;
	onDescribe: (indexAfter?: boolean) => void;
	onEmbed: (force?: boolean) => void;
	appliedTags: string[];
	autoTagDescriptions: boolean;
	onAutoTagDescriptionsChange: (enabled: boolean) => void;
	onAddSuggestedTags: (names: string[]) => Promise<void>;
}

export function MediaAnalysisDetails({
	status, textEmbed, describing, embedding, onDescribe, onEmbed,
	appliedTags, autoTagDescriptions, onAutoTagDescriptionsChange, onAddSuggestedTags,
}: MediaAnalysisDetailsProps): React.JSX.Element {
	const { t } = useLocale();
	const { confirm } = useConfirmation();
	const [addingTags, setAddingTags] = useState(false);
	const description = status.description;
	const applied = new Set(appliedTags.map((tag) => tag.toLowerCase()));
	const pendingTags = description?.tags.filter((tag) => !applied.has(tag.toLowerCase())) ?? [];
	async function addTag(name: string): Promise<void> {
		setAddingTags(true);
		try { await onAddSuggestedTags([name]); }
		catch { /* the caller displays the write failure */ }
		finally { setAddingTags(false); }
	}
	const described = status.status === "ready" && !status.stale && Boolean(description?.caption.trim());
	const indexing = embedding || textEmbed?.status === "embedding";
	const busy = describing || status.status === "describing" || indexing || addingTags;
	async function describeAndIndex(): Promise<void> {
		if (described && !await confirm({
			title: t.details.redescribeConfirmTitle,
			description: t.details.redescribeAndIndexConfirmBody,
			confirmLabel: t.details.describeAndIndex,
		})) return;
		onDescribe(true);
	}
	return (
		<section className="media-analysis-details" aria-label={t.details.mediaAnalysis}>
			<div className="section-label enrichment-heading detail-section-heading">
				<span>{t.details.mediaAnalysis}</span>
				<button type="button" className="detail-action-button detail-action-primary" disabled={busy} onClick={() => void describeAndIndex()}>
					{t.details.describeAndIndex}
				</button>
			</div>
			<label className="description-auto-tags">
				<input type="checkbox" checked={autoTagDescriptions} disabled={busy} onChange={(event) => onAutoTagDescriptionsChange(event.target.checked)} />
				{t.details.autoDescriptionTags}
			</label>
			<div className="media-analysis-sections">
				<MediaDescriptionDetails status={status} busy={describing} embedding={indexing} onDescribe={() => onDescribe()} />
				{described && !describing && (
					<TextEmbedDetails status={textEmbed} embedding={embedding} onEmbed={onEmbed} />
				)}
				{description?.caption && (
					<div className="media-description-body">
						<div className="section-label">{t.details.caption}</div>
						<p className="description-caption">{description.caption}</p>
					</div>
				)}
				{pendingTags.length > 0 && (
					<div className="description-suggestions">
						<div className="section-label">{t.details.suggestedTags}</div>
						<div className="tag-chips">
							{pendingTags.map((tag) => (
								<span key={tag} className="tag-chip">
									<span className="tag-chip-name">{tag}</span>
									<button type="button" aria-label={t.details.addSuggestedTag(tag)} disabled={!described || busy} onClick={() => void addTag(tag)}><TagActionIcon action="add" /></button>
								</span>
							))}
						</div>
					</div>
				)}
				{description?.transcript && (
					<details className="description-transcript">
						<summary>{t.details.transcript}</summary>
						<p className="description-caption">{description.transcript}</p>
					</details>
				)}
			</div>
		</section>
	);
}

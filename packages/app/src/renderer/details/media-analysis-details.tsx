import type { AudioWriteupStatus, ImageVlmStatus, TextEmbedStatus, VideoVlmStatus } from "@loom/core";
import { useLocale } from "../locale.tsx";
import { useConfirmation } from "../components/confirm-dialog.tsx";
import { MediaDescriptionDetails } from "./media-description-details.tsx";
import { TextEmbedDetails } from "./text-embed-details.tsx";

interface MediaAnalysisDetailsProps {
	status: ImageVlmStatus | VideoVlmStatus | AudioWriteupStatus;
	textEmbed: TextEmbedStatus | undefined;
	describing: boolean;
	embedding: boolean;
	onDescribe: (indexAfter?: boolean) => void;
	onEmbed: (force?: boolean) => void;
}

export function MediaAnalysisDetails({
	status, textEmbed, describing, embedding, onDescribe, onEmbed,
}: MediaAnalysisDetailsProps): React.JSX.Element {
	const { t } = useLocale();
	const { confirm } = useConfirmation();
	const described = status.status === "ready" && !status.stale && Boolean(status.markdown?.trim());
	const indexing = embedding || textEmbed?.status === "embedding";
	const busy = describing || status.status === "describing" || indexing;
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
			<div className="media-analysis-sections">
				<MediaDescriptionDetails status={status} busy={describing} embedding={indexing} onDescribe={() => onDescribe()} />
				{described && !describing && (
					<TextEmbedDetails status={textEmbed} embedding={embedding} onEmbed={onEmbed} />
				)}
				{status.markdown && (
					<dl className="properties analysis-properties media-writeup">
						<dt>{t.details.writeup}</dt>
						<dd className="vlm-markdown" data-tooltip={status.markdown}>{status.markdown}</dd>
					</dl>
				)}
			</div>
		</section>
	);
}

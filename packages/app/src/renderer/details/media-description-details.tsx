import type { AudioWriteupStatus, ImageVlmStatus, TextEmbedStatus, VideoVlmStatus } from "@loom/core";
import { rawStatusLabel } from "../../shared/locale.ts";
import { useLocale } from "../locale.tsx";
import { CopyableError } from "../components/copyable-error.tsx";
import { useConfirmation } from "../components/confirm-dialog.tsx";

type DescriptionStatus = ImageVlmStatus | VideoVlmStatus | AudioWriteupStatus;

interface MediaDescriptionDetailsProps {
	status: DescriptionStatus;
	textEmbed: TextEmbedStatus | undefined;
	busy: boolean;
	embedding: boolean;
	onDescribe: () => void;
	onEmbed: (force?: boolean) => void;
}

/** Describe and index an image, video, or audio file as one step with one status. */
export function MediaDescriptionDetails({
	status,
	textEmbed,
	busy: requested,
	embedding,
	onDescribe,
	onEmbed,
}: MediaDescriptionDetailsProps): React.JSX.Element {
	const { t } = useLocale();
	const { choose } = useConfirmation();
	const described = status.status === "ready" && !status.stale;
	const indexing = described && textEmbed?.status === "embedding";
	const busy = requested || embedding || status.status === "describing" || indexing;
	// The model is always asked again. When a fresh description exists, the user picks first.
	const label = status.status === "ready" && status.stale ? t.details.redescribe : t.details.describe;
	const error = status.error ?? (described ? textEmbed?.error : undefined);
	const chunks = described && textEmbed && textEmbed.status === "ready"
		? t.details.chunks(textEmbed.childCount, textEmbed.parentCount)
		: undefined;
	const model = [status.modelId, described ? textEmbed?.modelId : undefined].filter(Boolean).join(" · ");
	async function describe(): Promise<void> {
		if (!described) { onDescribe(); return; }
		const choice = await choose({
			title: t.details.describeChoiceTitle,
			description: t.details.describeChoiceBody,
			choices: [
				{ id: "index", label: t.details.indexOnly },
				{ id: "describe", label: t.details.redescribeAndIndex, primary: true },
			],
		});
		if (choice === "index") onEmbed(true);
		else if (choice === "describe") onDescribe();
	}
	return (
		<section>
			<div className="section-label enrichment-heading">
				<span>{t.details.caption}</span>
				<button type="button" className="text-button" disabled={busy} onClick={() => void describe()}>
					{busy ? (indexing || embedding ? t.details.embedding : t.details.describing) : label}
				</button>
			</div>
			<dl className="properties">
				<dt>{t.details.status}</dt>
				<dd title={chunks}>{formatStatus(t, status, textEmbed, described)}</dd>
				{status.modelId && (
					<>
						<dt>{t.details.model}</dt>
						<dd title={model}>{status.modelId}</dd>
					</>
				)}
				{status.markdown && (
					<>
						<dt>{t.details.writeup}</dt>
						<dd className="vlm-markdown" title={status.markdown}>{status.markdown}</dd>
					</>
				)}
				{error && (
					<>
						<dt>{t.details.error}</dt>
						<dd className="copyable-error-cell"><CopyableError text={error} /></dd>
					</>
				)}
			</dl>
		</section>
	);
}

function formatStatus(
	t: ReturnType<typeof useLocale>["t"],
	status: DescriptionStatus,
	textEmbed: TextEmbedStatus | undefined,
	described: boolean,
): string {
	if (status.status === "idle") return t.details.notDescribed;
	const label = rawStatusLabel(t, status.status);
	if (status.stale) return t.status.stale(label);
	if (!described || !textEmbed?.supported) return label;
	if (textEmbed.status === "ready") return textEmbed.stale ? t.status.stale(label) : label;
	if (textEmbed.status === "idle") return t.details.notIndexed;
	return rawStatusLabel(t, textEmbed.status);
}

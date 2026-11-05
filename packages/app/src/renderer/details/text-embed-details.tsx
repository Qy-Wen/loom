import type { TextEmbedStatus } from "@loom/core";
import { rawStatusLabel } from "../../shared/locale.ts";
import { useLocale } from "../locale.tsx";
import { CopyableError } from "../components/copyable-error.tsx";
import { useConfirmation } from "../components/confirm-dialog.tsx";
import { TooltipText } from "../components/tooltip-text.tsx";

interface TextEmbedDetailsProps {
	status: TextEmbedStatus | undefined;
	embedding: boolean;
	onEmbed: (force?: boolean) => void;
}

export function TextEmbedDetails({
	status,
	embedding,
	onEmbed,
}: TextEmbedDetailsProps): React.JSX.Element | null {
	const { t } = useLocale();
	const { confirm } = useConfirmation();
	if (!status?.supported) return null;
	const busy = embedding || status.status === "embedding";
	// A current index is never skipped silently: ask first, then rebuild it.
	const current = status.status === "ready" && !status.stale;
	const label = status.status === "ready" ? t.details.reembed : t.details.embed;
	const chunks = status.status === "ready" ? t.details.chunks(status.childCount, status.parentCount) : undefined;
	const tooltip = [status.modelId ? `${t.details.model}: ${status.modelId}` : undefined, chunks].filter(Boolean).join("\n") || undefined;
	async function embed(): Promise<void> {
		if (current && !await confirm({
			title: t.details.reembedConfirmTitle,
			description: t.details.reembedConfirmBody,
			confirmLabel: t.details.reembed,
		})) return;
		onEmbed(current ? true : undefined);
	}
	return (
		<section aria-label={t.details.indexStatus}>
			<dl className="properties analysis-properties">
				<dt className="analysis-status-label">{t.details.index}<br />{t.details.status}</dt>
				<dd className="analysis-status">
					<TooltipText text={formatStatus(t, status)} tooltip={tooltip} />
					<button type="button" className="detail-action-button" disabled={busy} onClick={() => void embed()}>
						{busy ? t.details.embedding : label}
					</button>
				</dd>
				{status.truncated && (
					<>
						<dt>{t.details.coverage}</dt>
						<dd>{t.details.partialIndex}</dd>
					</>
				)}
				{status.error && (
					<>
						<dt>{t.details.error}</dt>
						<dd className="copyable-error-cell"><CopyableError text={status.error} /></dd>
					</>
				)}
			</dl>
		</section>
	);
}

function formatStatus(t: ReturnType<typeof useLocale>["t"], status: TextEmbedStatus): string {
	if (status.status === "idle") return t.details.notIndexed;
	const label = rawStatusLabel(t, status.status);
	return status.stale ? t.status.stale(label) : label;
}

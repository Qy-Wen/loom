import { useState } from "react";
import type { TextEmbedStatus } from "@loom/core";
import { rawStatusLabel } from "../../shared/locale.ts";
import { useLocale } from "../locale.tsx";
import { CopyableError } from "../components/copyable-error.tsx";
import { ConfirmDialog } from "../components/confirm-dialog.tsx";

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
	const [confirming, setConfirming] = useState(false);
	if (!status?.supported) return null;
	const busy = embedding || status.status === "embedding";
	// A current index is never skipped silently: ask first, then rebuild it.
	const current = status.status === "ready" && !status.stale;
	const label = status.stale && status.status === "ready" ? t.details.reembed : t.details.embed;
	return (
		<section>
			<div className="section-label enrichment-heading">
				<span>{t.details.index}</span>
				<button type="button" className="text-button" disabled={busy} onClick={() => (current ? setConfirming(true) : onEmbed())}>
					{busy ? t.details.embedding : label}
				</button>
			</div>
			<dl className="properties">
				<dt>{t.details.status}</dt>
				<dd>{formatStatus(t, status)}</dd>
				{status.modelId && (
					<>
						<dt>{t.details.model}</dt>
						<dd title={status.modelId}>{status.modelId}</dd>
					</>
				)}
				{(status.status !== "idle" || status.childCount > 0) && (
					<>
						<dt>{t.details.chunksLabel}</dt>
						<dd>{t.details.chunks(status.childCount, status.parentCount)}</dd>
					</>
				)}
				{status.error && (
					<>
						<dt>{t.details.error}</dt>
						<dd className="copyable-error-cell"><CopyableError text={status.error} /></dd>
					</>
				)}
			</dl>
			{confirming && (
				<ConfirmDialog
					title={t.details.reembedConfirmTitle}
					body={t.details.reembedConfirmBody}
					confirmLabel={t.details.reembed}
					onCancel={() => setConfirming(false)}
					onConfirm={() => { setConfirming(false); onEmbed(true); }}
				/>
			)}
		</section>
	);
}

function formatStatus(t: ReturnType<typeof useLocale>["t"], status: TextEmbedStatus): string {
	if (status.status === "idle") return t.details.notIndexed;
	const label = rawStatusLabel(t, status.status);
	return status.stale ? t.status.stale(label) : label;
}

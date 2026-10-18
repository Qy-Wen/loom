import type { AudioWriteupStatus, ImageVlmStatus, VideoVlmStatus } from "@loom/core";
import { rawStatusLabel } from "../../shared/locale.ts";
import { useLocale } from "../locale.tsx";
import { CopyableError } from "../components/copyable-error.tsx";

interface ImageVlmDetailsProps {
	status: ImageVlmStatus | VideoVlmStatus | AudioWriteupStatus | undefined;
	describing: boolean;
	onDescribe: () => void;
}

export function ImageVlmDetails({
	status,
	describing,
	onDescribe,
}: ImageVlmDetailsProps): React.JSX.Element | null {
	const { t } = useLocale();
	if (!status?.supported) return null;
	const busy = describing || status.status === "describing";
	const label = status.stale && status.status === "ready" ? t.details.redescribe : t.details.describe;
	return (
		<section>
			<div className="section-label enrichment-heading">
				<span>{t.details.caption}</span>
				<button type="button" className="text-button" disabled={busy} onClick={onDescribe}>
					{busy ? t.details.describing : label}
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
				{status.markdown && (
					<>
						<dt>{t.details.writeup}</dt>
						<dd className="vlm-markdown" title={status.markdown}>{status.markdown}</dd>
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

function formatStatus(t: ReturnType<typeof useLocale>["t"], status: ImageVlmStatus | VideoVlmStatus | AudioWriteupStatus): string {
	if (status.status === "idle") return t.details.notDescribed;
	const label = rawStatusLabel(t, status.status);
	return status.stale ? t.status.stale(label) : label;
}

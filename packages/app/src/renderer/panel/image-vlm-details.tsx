import type { ImageVlmStatus, VideoVlmStatus } from "@loom/core";

interface ImageVlmDetailsProps {
	status: ImageVlmStatus | VideoVlmStatus | undefined;
	describing: boolean;
	onDescribe: () => void;
}

export function ImageVlmDetails({
	status,
	describing,
	onDescribe,
}: ImageVlmDetailsProps): React.JSX.Element | null {
	if (!status?.supported) return null;
	const busy = describing || status.status === "describing";
	const label = status.stale && status.status === "ready" ? "Re-describe" : "Describe";
	return (
		<section>
			<div className="section-label enrichment-heading">
				<span>Caption</span>
				<button type="button" className="text-button" disabled={busy} onClick={onDescribe}>
					{busy ? "Describing…" : label}
				</button>
			</div>
			<dl className="properties">
				<dt>Status</dt>
				<dd>{formatStatus(status)}</dd>
				{status.modelId && (
					<>
						<dt>Model</dt>
						<dd title={status.modelId}>{status.modelId}</dd>
					</>
				)}
				{status.markdown && (
					<>
						<dt>Write-up</dt>
						<dd className="vlm-markdown" title={status.markdown}>{status.markdown}</dd>
					</>
				)}
				{status.error && (
					<>
						<dt>Error</dt>
						<dd title={status.error}>{status.error}</dd>
					</>
				)}
			</dl>
		</section>
	);
}

function formatStatus(status: ImageVlmStatus | VideoVlmStatus): string {
	if (status.status === "idle") return "Not described";
	if (status.stale) return `${status.status} (stale)`;
	return status.status;
}

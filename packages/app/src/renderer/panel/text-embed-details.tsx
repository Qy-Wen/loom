import type { TextEmbedStatus } from "@loom/core";

interface TextEmbedDetailsProps {
	status: TextEmbedStatus | undefined;
	embedding: boolean;
	onEmbed: () => void;
}

export function TextEmbedDetails({
	status,
	embedding,
	onEmbed,
}: TextEmbedDetailsProps): React.JSX.Element | null {
	if (!status?.supported) return null;
	const busy = embedding || status.status === "embedding";
	const label = status.stale && status.status === "ready" ? "Re-embed" : "Embed";
	return (
		<section>
			<div className="section-label enrichment-heading">
				<span>Index</span>
				<button type="button" className="text-button" disabled={busy} onClick={onEmbed}>
					{busy ? "Embedding…" : label}
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
				{(status.status !== "idle" || status.childCount > 0) && (
					<>
						<dt>Chunks</dt>
						<dd>{status.childCount} child / {status.parentCount} parent</dd>
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

function formatStatus(status: TextEmbedStatus): string {
	if (status.status === "idle") return "Not indexed";
	if (status.stale) return `${status.status} (stale)`;
	return status.status;
}

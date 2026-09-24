import type { AssetEnrichment, EnrichmentData } from "@loom/core";

interface EnrichmentDetailsProps {
	enrichment: AssetEnrichment | undefined;
	analyzing: boolean;
	onAnalyze: () => void;
}

export function EnrichmentDetails({
	enrichment,
	analyzing,
	onAnalyze,
}: EnrichmentDetailsProps): React.JSX.Element {
	return (
		<section>
			<div className="section-label enrichment-heading">
				<span>Technical</span>
				<button type="button" className="text-button" disabled={analyzing} onClick={onAnalyze}>
					{analyzing ? "Analyzing…" : "Analyze"}
				</button>
			</div>
			{enrichment ? (
				<dl className="properties">
					<dt>Status</dt><dd>{enrichment.status}</dd>
					{enrichment.error && <><dt>Error</dt><dd title={enrichment.error}>{enrichment.error}</dd></>}
					{enrichment.data && <EnrichmentFields data={enrichment.data} />}
				</dl>
			) : (
				<div className="empty no-padding">Not analyzed yet.</div>
			)}
		</section>
	);
}

function EnrichmentFields({ data }: { data: EnrichmentData }): React.JSX.Element {
	if (data.kind === "image") {
		return (
			<>
				<dt>Size</dt><dd>{data.width} × {data.height}</dd>
				{data.orientation !== undefined && <><dt>Orientation</dt><dd>{data.orientation}</dd></>}
				{data.camera && <><dt>Camera</dt><dd>{data.camera}</dd></>}
				{data.capturedAt && <><dt>Captured</dt><dd>{data.capturedAt}</dd></>}
			</>
		);
	}
	if (data.kind === "video") {
		return (
			<>
				<dt>Duration</dt><dd>{formatDuration(data.duration)}</dd>
				{(data.width || data.height) && <><dt>Size</dt><dd>{data.width ?? "?"} × {data.height ?? "?"}</dd></>}
				{data.videoCodec && <><dt>Video</dt><dd>{data.videoCodec}</dd></>}
				{data.audioCodec && <><dt>Audio</dt><dd>{data.audioCodec}</dd></>}
				{data.frameRate !== undefined && <><dt>FPS</dt><dd>{round(data.frameRate)}</dd></>}
			</>
		);
	}
	if (data.kind === "audio") {
		return (
			<>
				<dt>Duration</dt><dd>{formatDuration(data.duration)}</dd>
				{data.audioCodec && <><dt>Audio</dt><dd>{data.audioCodec}</dd></>}
			</>
		);
	}
	return (
		<>
			<dt>Characters</dt><dd>{data.charCount}{data.truncated ? " (truncated)" : ""}</dd>
			<dt>Text</dt><dd title={data.text}>{data.text.slice(0, 160)}</dd>
		</>
	);
}

function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const minutes = Math.floor(total / 60);
	const remain = total % 60;
	return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function round(value: number): string {
	return String(Math.round(value * 100) / 100);
}

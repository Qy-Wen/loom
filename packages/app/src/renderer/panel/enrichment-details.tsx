import type { AssetEnrichment, EnrichmentData } from "@loom/core";
import { CopyableError } from "./copyable-error.tsx";

interface EnrichmentDetailsProps {
	enrichment: AssetEnrichment | undefined;
}

export function EnrichmentDetails({
	enrichment,
}: EnrichmentDetailsProps): React.JSX.Element | null {
	if (!enrichment || (!enrichment.error && !enrichment.data)) return null;
	return (
		<>
			{enrichment.error && (
				<>
					<dt>Error</dt>
					<dd className="copyable-error-cell"><CopyableError text={enrichment.error} /></dd>
				</>
			)}
			{enrichment.data && <EnrichmentFields data={enrichment.data} />}
		</>
	);
}

function EnrichmentFields({ data }: { data: EnrichmentData }): React.JSX.Element {
	if (data.kind === "image") {
		return (
			<>
				<dt>Dimensions</dt><dd>{data.width} × {data.height}</dd>
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
				{(data.width || data.height) && <><dt>Dimensions</dt><dd>{data.width ?? "?"} × {data.height ?? "?"}</dd></>}
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

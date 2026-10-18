import type { AssetEnrichment, EnrichmentData } from "@loom/core";
import { useLocale } from "../locale.tsx";
import { CopyableError } from "../components/copyable-error.tsx";

interface EnrichmentDetailsProps {
	enrichment: AssetEnrichment | undefined;
}

export function EnrichmentDetails({
	enrichment,
}: EnrichmentDetailsProps): React.JSX.Element | null {
	const { t } = useLocale();
	if (!enrichment || (!enrichment.error && !enrichment.data)) return null;
	return (
		<>
			{enrichment.error && (
				<>
					<dt>{t.details.error}</dt>
					<dd className="copyable-error-cell"><CopyableError text={enrichment.error} /></dd>
				</>
			)}
			{enrichment.data && <EnrichmentFields data={enrichment.data} />}
		</>
	);
}

function EnrichmentFields({ data }: { data: EnrichmentData }): React.JSX.Element {
	const { t } = useLocale();
	if (data.kind === "image") {
		return (
			<>
				<dt>{t.details.dimensions}</dt><dd>{data.width} × {data.height}</dd>
				{data.orientation !== undefined && <><dt>{t.details.orientation}</dt><dd>{data.orientation}</dd></>}
				{data.camera && <><dt>{t.details.camera}</dt><dd>{data.camera}</dd></>}
				{data.capturedAt && <><dt>{t.details.captured}</dt><dd>{data.capturedAt}</dd></>}
			</>
		);
	}
	if (data.kind === "video") {
		return (
			<>
				<dt>{t.details.duration}</dt><dd>{formatDuration(data.duration)}</dd>
				{(data.width || data.height) && <><dt>{t.details.dimensions}</dt><dd>{data.width ?? "?"} × {data.height ?? "?"}</dd></>}
				{data.videoCodec && <><dt>{t.details.video}</dt><dd>{data.videoCodec}</dd></>}
				{data.audioCodec && <><dt>{t.details.audio}</dt><dd>{data.audioCodec}</dd></>}
				{data.frameRate !== undefined && <><dt>{t.details.fps}</dt><dd>{round(data.frameRate)}</dd></>}
			</>
		);
	}
	if (data.kind === "audio") {
		return (
			<>
				<dt>{t.details.duration}</dt><dd>{formatDuration(data.duration)}</dd>
				{data.audioCodec && <><dt>{t.details.audio}</dt><dd>{data.audioCodec}</dd></>}
			</>
		);
	}
	return (
		<>
			<dt>{t.details.characters}</dt><dd>{data.charCount}{data.truncated ? t.details.truncated : ""}</dd>
			<dt>{t.details.text}</dt><dd title={data.text}>{data.text.slice(0, 160)}</dd>
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

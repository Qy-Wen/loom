import type { Asset } from "@loom/core";
import { extensionOf } from "./asset-utils.ts";

const paths = {
	markdown: "M2 11V5l3 3 3-3v6m3-2 2 2 2-2m-2-4v6",
	canvas: "M2 3h4v4H2zM10 9h4v4h-4zM6 5h4a2 2 0 0 1 2 2v2",
	pdf: "M4 2h5l3 3v9H4zM9 2v3h3M6.25 11.5v-4H8a1 1 0 0 1 0 2H6.25",
	table: "M2 3.5h12v9H2zM2 7h12M7 3.5v9",
	code: "M5 4 2 8l3 4m6-8 3 4-3 4m-2-8-2 8",
	image: "M2 3.5h12v9H2zM2 11l3.5-3.5L8 10l2-2 4 4m-3-6h.01",
	video: "M2 3.5h12v9H2zM6.5 6l4 2-4 2z",
	audio: "M6 11.5V4l7-1v7.5M6 11.5a2 1.5 0 1 1-4 0 2 1.5 0 0 1 4 0Zm7-1a2 1.5 0 1 1-4 0 2 1.5 0 0 1 4 0Z",
	text: "M4 2h5l3 3v9H4zM9 2v3h3M6 8h4m-4 3h4",
	other: "M4 2h5l3 3v9H4zM9 2v3h3",
};

const iconsByExtension: Partial<Record<string, keyof typeof paths>> = {
	".md": "markdown",
	".canvas": "canvas",
	".pdf": "pdf",
	".csv": "table",
	".html": "code",
	".json": "code",
};

export function AssetFileIcon({ asset, size = 16 }: { asset: Pick<Asset, "filename" | "type">; size?: number }): React.JSX.Element {
	const kind = iconsByExtension[extensionOf(asset.filename)] ?? asset.type;
	return <svg className="asset-file-icon" data-kind={kind} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"
		focusable="false" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
		<path d={paths[kind]} />
	</svg>;
}

import { useState } from "react";
import { useDefaultRenderTool } from "@copilotkit/react-core/v2";
import { assetRefsFromTool, type AssetRef } from "../../shared/asset-refs.ts";
import { useOpenAsset } from "./asset-open.tsx";

/** Register a chat renderer so tool results are visible in CopilotChat. */
export function ToolCallViews(): null {
	useDefaultRenderTool({
		render: (props) => <ToolCallCard {...props} />,
	}, []);
	return null;
}

function ToolCallCard({
	name,
	status,
	parameters,
	result,
}: {
	name: string;
	status: string;
	parameters?: unknown;
	result?: unknown;
}) {
	const openAsset = useOpenAsset();
	const [open, setOpen] = useState(false);
	const done = status === "complete";
	const refs = done ? assetRefsFromTool(name, result) : null;
	const body = refs ? "" : formatToolBody(parameters, done ? result : undefined);
	const faded = !open && hasMoreThanPreview(body);

	return (
		<div className={`tool-call${open ? " open" : ""}${faded ? " faded" : ""}`}>
			<button
				className="tool-call-head"
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
			>
				<span className="tool-call-chevron" aria-hidden="true" />
				<span className="tool-call-name">{name}</span>
				<span className="tool-call-status">{done ? "done" : status}</span>
			</button>
			{refs ? (
				<div className="tool-call-refs">
					{refs.length === 0 ? <span className="tool-call-refs-empty">No assets</span> : refs.map((ref) => (
						<AssetRefButton key={ref.assetId} asset={ref} onOpen={openAsset} />
					))}
				</div>
			) : body ? (
				<div
					className="tool-call-body"
					onClick={open ? undefined : () => setOpen(true)}
				>
					<pre className="tool-call-result">{body}</pre>
				</div>
			) : null}
		</div>
	);
}

function AssetRefButton({ asset, onOpen }: { asset: AssetRef; onOpen: (assetId: string) => void }): React.JSX.Element {
	return (
		<button
			type="button"
			className="asset-ref"
			title={asset.path}
			onClick={() => onOpen(asset.assetId)}
		>
			{asset.filename}
		</button>
	);
}

function formatToolBody(parameters: unknown, result: unknown): string {
	const parts = [`arguments\n${formatToolValue(parameters)}`];
	if (result != null && result !== "") parts.push(`result\n${formatToolValue(result)}`);
	return parts.join("\n\n");
}

function hasMoreThanPreview(text: string): boolean {
	return text.split("\n").filter((line) => line.trim()).length > 4;
}

function formatToolValue(value: unknown): string {
	if (typeof value === "string") {
		try {
			return JSON.stringify(JSON.parse(value), null, 2);
		} catch {
			return value;
		}
	}
	try {
		return JSON.stringify(value ?? {}, null, 2);
	} catch {
		return String(value);
	}
}

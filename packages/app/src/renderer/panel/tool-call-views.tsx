import { useState } from "react";
import { useDefaultRenderTool } from "@copilotkit/react-core/v2";
import { toolCallNeedsApproval, toolPathArg, type ToolGateDecision } from "@loom/agent/tool-permission";
import { assetRefsFromTool, type AssetRef } from "../../shared/asset-refs.ts";
import { useAgentPermission } from "./agent-permission.tsx";
import { useOpenAsset } from "./asset-open.tsx";
import { useToolGatePending } from "./tool-gate-pending.ts";

/** Register a chat renderer so tool results are visible in CopilotChat. */
export function ToolCallViews({ libraryRoot }: { libraryRoot: string | null }): null {
	useDefaultRenderTool({
		render: (props) => <ToolCallCard {...props} libraryRoot={libraryRoot} />,
	}, [libraryRoot]);
	return null;
}

const decidedCalls = new Set<string>();

function ToolCallCard({
	name,
	status,
	parameters,
	result,
	toolCallId,
	libraryRoot,
}: {
	name: string;
	status: string;
	parameters?: unknown;
	result?: unknown;
	toolCallId?: string;
	libraryRoot: string | null;
}) {
	const openAsset = useOpenAsset();
	const { level } = useAgentPermission();
	const gatePending = useToolGatePending(toolCallId);
	const [open, setOpen] = useState(false);
	const [acted, setActed] = useState(false);
	const done = status === "complete";
	const pathGated = level === "standard" && (name === "write" || name === "edit");
	const waiting = Boolean(toolCallId) && !done && !acted && !decidedCalls.has(toolCallId ?? "")
		&& (gatePending || (toolCallNeedsApproval(level, name, libraryRoot, parameters) && (!pathGated || toolPathArg(parameters) !== undefined)));
	const refs = done ? assetRefsFromTool(name, result) : null;
	const body = refs ? `arguments\n${formatToolValue(parameters)}` : formatToolBody(parameters, done ? result : undefined);
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
				<span className="tool-call-status">{waiting ? "waiting" : done ? "done" : status}</span>
			</button>
			{waiting && toolCallId ? (
				<div className="tool-call-gate">
					<button type="button" onClick={() => { void decide(toolCallId, "approve", setActed); }}>Approve</button>
					<button type="button" onClick={() => { void decide(toolCallId, "reject", setActed); }}>Skip</button>
				</div>
			) : null}
			{body ? (
				<div
					className="tool-call-body"
					onClick={open ? undefined : () => setOpen(true)}
				>
					<pre className="tool-call-result">{body}</pre>
				</div>
			) : null}
			{refs ? (
				<div className="tool-call-refs">
					{refs.length === 0 ? <span className="tool-call-refs-empty">No assets</span> : refs.map((ref) => (
						<AssetRefButton key={ref.assetId} asset={ref} onOpen={openAsset} />
					))}
				</div>
			) : null}
		</div>
	);
}

async function decide(
	toolCallId: string,
	decision: ToolGateDecision,
	setActed: (acted: boolean) => void,
): Promise<void> {
	decidedCalls.add(toolCallId);
	setActed(true);
	await window.loom.resolveToolGate(toolCallId, decision);
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

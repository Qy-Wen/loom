import { useState } from "react";
import { ToolCard } from "@loom/ag-ui-react";
import { commandAllowKey, toolCallNeedsApproval, toolPathArg, type CommandAllow, type ToolGateDecision } from "@loom/agent/tool-permission";
import { assetRefsFromTool, type AssetRef } from "../../shared/asset-refs.ts";
import { toolResultParts } from "../../shared/tool-result-content.ts";
import { useAgentPermission } from "./agent-permission.tsx";
import { useOpenAsset } from "./asset-open.tsx";
import { useLocale } from "../locale.tsx";
import { useToolGatePending } from "./tool-gate-pending.ts";

const decidedCalls = new Set<string>();

export function ToolCallCard({
	name,
	done,
	parameters,
	result,
	toolCallId,
	libraryRoot,
	allows,
}: {
	name: string;
	done: boolean;
	parameters?: unknown;
	result?: unknown;
	toolCallId?: string;
	libraryRoot: string | null;
	allows: readonly CommandAllow[];
}) {
	const openAsset = useOpenAsset();
	const { t } = useLocale();
	const { level } = useAgentPermission();
	const gatePending = useToolGatePending(toolCallId);
	const [acted, setActed] = useState(false);
	const [gateError, setGateError] = useState<string | null>(null);
	const pathGated = level === "standard" && (name === "write" || name === "edit");
	const waiting = Boolean(toolCallId) && !done && !acted && !decidedCalls.has(toolCallId ?? "")
		&& (gatePending || (toolCallNeedsApproval(level, name, libraryRoot, parameters, allows) && (!pathGated || toolPathArg(parameters) !== undefined)));
	const remember = waiting ? commandAllowKey(name, parameters, libraryRoot) : undefined;
	const refs = done ? assetRefsFromTool(name, result) : null;
	const resultParts = done ? toolResultParts(result) : null;
	const images = resultParts?.filter((part) => part.type === "image") ?? [];
	const displayResult = resultParts ? resultParts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") : result;
	return <ToolCard
		name={name}
		status={waiting ? t.tool.waiting : done ? t.tool.done : t.chat.working}
		parameters={parameters}
		result={done && !refs ? displayResult : undefined}
		resultContent={images.length > 0 || refs !== null ? <>
			{images.length > 0 && (
				<div className="tool-call-images">
					{images.map((part, index) => <img key={index} src={"url" in part ? part.url : `data:${part.mimeType};base64,${part.data}`} loading="lazy" decoding="async" alt={`${t.tool.image} ${index + 1}`} />)}
				</div>
			)}
			{refs && (
				<div className="tool-call-refs">
					{refs.length === 0 ? <span className="tool-call-refs-empty">{t.tool.noAssets}</span> : refs.map((ref) => (
						<AssetRefButton key={ref.assetId} asset={ref} onOpen={openAsset} />
					))}
				</div>
			)}
		</> : undefined}
		actions={waiting && toolCallId ? (
			<div className="tool-call-gate">
				<button type="button" onClick={() => { void decide(toolCallId, "approve", setActed, setGateError); }}>{t.tool.approve}</button>
				{remember && (
					<button type="button" onClick={() => { void decide(toolCallId, "approve_always", setActed, setGateError); }}>{t.tool.always}</button>
				)}
				<button type="button" onClick={() => { void decide(toolCallId, "reject", setActed, setGateError); }}>{t.tool.skip}</button>
			</div>
		) : undefined}
		actionError={gateError}
	/>;
}

async function decide(
	toolCallId: string,
	decision: ToolGateDecision,
	setActed: (acted: boolean) => void,
	setGateError: (message: string | null) => void,
): Promise<void> {
	decidedCalls.add(toolCallId);
	setActed(true);
	setGateError(null);
	try {
		await window.loom.resolveToolGate(toolCallId, decision);
	} catch (cause) {
		decidedCalls.delete(toolCallId);
		setActed(false);
		setGateError(cause instanceof Error ? cause.message : String(cause));
	}
}

function AssetRefButton({ asset, onOpen }: { asset: AssetRef; onOpen: (assetId: string) => void }): React.JSX.Element {
	return (
		<button
			type="button"
			className="asset-ref"
			data-tooltip={asset.path}
			onClick={() => onOpen(asset.assetId)}
		>
			{asset.filename}
		</button>
	);
}

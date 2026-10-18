import { useState } from "react";
import { useDefaultRenderTool } from "@copilotkit/react-core/v2";
import { commandAllowKey, toolCallNeedsApproval, toolPathArg, type CommandAllow, type ToolGateDecision } from "@loom/agent/tool-permission";
import { useCommandAllows } from "./command-allows.ts";
import { assetRefsFromTool, type AssetRef } from "../../shared/asset-refs.ts";
import { toolResultParts } from "../../shared/tool-result-content.ts";
import { useAgentPermission } from "./agent-permission.tsx";
import { useOpenAsset } from "./asset-open.tsx";
import { useLocale } from "../locale.tsx";
import { useToolGatePending } from "./tool-gate-pending.ts";

/** Register a chat renderer so tool results are visible in CopilotChat. */
export function ToolCallViews({ libraryRoot }: { libraryRoot: string | null }): null {
	const { allows } = useCommandAllows();
	useDefaultRenderTool({
		render: (props) => <ToolCallCard {...props} libraryRoot={libraryRoot} allows={allows} />,
	}, [libraryRoot, allows]);
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
	allows,
}: {
	name: string;
	status: string;
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
	const [open, setOpen] = useState(false);
	const [acted, setActed] = useState(false);
	const [gateError, setGateError] = useState<string | null>(null);
	const done = status === "complete";
	const pathGated = level === "standard" && (name === "write" || name === "edit");
	const waiting = Boolean(toolCallId) && !done && !acted && !decidedCalls.has(toolCallId ?? "")
		&& (gatePending || (toolCallNeedsApproval(level, name, libraryRoot, parameters, allows) && (!pathGated || toolPathArg(parameters) !== undefined)));
	const remember = waiting ? commandAllowKey(name, parameters, libraryRoot) : undefined;
	const refs = done ? assetRefsFromTool(name, result) : null;
	const resultParts = done ? toolResultParts(result) : null;
	const images = resultParts?.filter((part) => part.type === "image") ?? [];
	const displayResult = resultParts ? resultParts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") : result;
	const body = refs ? `arguments\n${formatToolValue(parameters)}` : formatToolBody(parameters, done ? displayResult : undefined);
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
				<span className="tool-call-status">{waiting ? t.tool.waiting : done ? t.tool.done : status}</span>
			</button>
			{waiting && toolCallId ? (
				<div className="tool-call-gate">
					<button type="button" onClick={() => { void decide(toolCallId, "approve", setActed, setGateError); }}>{t.tool.approve}</button>
					{remember ? (
						<button type="button" onClick={() => { void decide(toolCallId, "approve_always", setActed, setGateError); }}>{t.tool.always}</button>
					) : null}
					<button type="button" onClick={() => { void decide(toolCallId, "reject", setActed, setGateError); }}>{t.tool.skip}</button>
				</div>
			) : null}
			{gateError ? <p className="tool-call-gate-error">{gateError}</p> : null}
			{body ? (
				<div
					className="tool-call-body"
					onClick={open ? undefined : () => setOpen(true)}
				>
					<pre className="tool-call-result">{body}</pre>
				</div>
			) : null}
			{images.length > 0 ? (
				<div className="tool-call-images">
					{images.map((part, index) => <img key={index} src={"url" in part ? part.url : `data:${part.mimeType};base64,${part.data}`} loading="lazy" decoding="async" alt={`${t.tool.image} ${index + 1}`} />)}
				</div>
			) : null}
			{refs ? (
				<div className="tool-call-refs">
					{refs.length === 0 ? <span className="tool-call-refs-empty">{t.tool.noAssets}</span> : refs.map((ref) => (
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

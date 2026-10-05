import { useEffect } from "react";
import type { ReactActivityMessageRenderer } from "@copilotkit/react-core/v2";
import { setToolGatePending } from "./tool-gate-pending.ts";

type RetryContent = {
	phase: "wait" | "running" | "done";
	attempt: number;
	maxAttempts?: number;
	delayMs?: number;
	errorMessage?: string;
};

type ToolProgressContent = {
	name: string;
	text: string;
	hidden: boolean;
};

type ToolGateContent = {
	toolCallId: string;
	pending: boolean;
};

const acceptContent = {
	"~standard": {
		version: 1 as const,
		vendor: "loom",
		validate: (value: unknown) => ({ value }),
	},
};

function formatDelay(delayMs: number): string {
	if (delayMs >= 1000) {
		const seconds = Math.max(1, Math.round(delayMs / 1000));
		return `${seconds}s`;
	}
	return `${delayMs}ms`;
}

function RetryActivity({ content }: { content: RetryContent }): React.JSX.Element | null {
	if (content.phase === "done") return null;
	const attempt = content.maxAttempts ? `attempt ${content.attempt} of ${content.maxAttempts}` : `attempt ${content.attempt}`;
	const label = content.phase === "wait" && content.delayMs !== undefined
		? `Retrying in ${formatDelay(content.delayMs)}`
		: "Retrying";
	return (
		<div className="run-activity" role="status">
			<div className="run-activity-head">
				<span className="run-activity-label">{label}</span>
				<span className="run-activity-meta">{attempt}</span>
			</div>
			{content.errorMessage ? <p className="run-activity-detail">{content.errorMessage}</p> : null}
		</div>
	);
}

function ToolGateActivity({ content }: { content: ToolGateContent }): null {
	useEffect(() => {
		setToolGatePending(content.toolCallId, content.pending);
	}, [content.toolCallId, content.pending]);
	return null;
}

function ToolProgressActivity({ content }: { content: ToolProgressContent }): React.JSX.Element | null {
	if (content.hidden || !content.text) return null;
	return (
		<div className="run-activity" role="status">
			<div className="run-activity-label">{content.name}</div>
			<pre className="run-activity-output">{content.text}</pre>
		</div>
	);
}

/** Live retry and tool-output rows. They replace themselves and disappear when the step finishes. */
export const runActivityRenderers: ReactActivityMessageRenderer<unknown>[] = [
	{
		activityType: "loom.retry",
		content: acceptContent as ReactActivityMessageRenderer<RetryContent>["content"],
		render: ({ content }) => <RetryActivity content={content as RetryContent} />,
	},
	{
		activityType: "loom.tool_progress",
		content: acceptContent as ReactActivityMessageRenderer<ToolProgressContent>["content"],
		render: ({ content }) => <ToolProgressActivity content={content as ToolProgressContent} />,
	},
	{
		activityType: "loom.tool_gate",
		content: acceptContent as ReactActivityMessageRenderer<ToolGateContent>["content"],
		render: ({ content }) => <ToolGateActivity content={content as ToolGateContent} />,
	},
];

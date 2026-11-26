import { useEffect } from "react";
import type { ActivityMessage } from "@ag-ui/core";
import { ChatActivity } from "@loom/ag-ui-react";
import { useLocale } from "../locale.tsx";
import { setToolGatePending } from "./tool-gate-pending.ts";

type RetryContent = {
	phase: "wait" | "running" | "done";
	attempt: number;
	maxAttempts?: number;
	delayMs?: number;
	errorMessage?: string;
};

type ToolGateContent = {
	toolCallId: string;
	pending: boolean;
};

function formatDelay(delayMs: number): string {
	if (delayMs >= 1000) {
		const seconds = Math.max(1, Math.round(delayMs / 1000));
		return `${seconds}s`;
	}
	return `${delayMs}ms`;
}

function RetryActivity({ content }: { content: RetryContent }): React.JSX.Element | null {
	const { t } = useLocale();
	if (content.phase === "done") return null;
	const attempt = content.maxAttempts ? t.activity.attemptOf(content.attempt, content.maxAttempts) : t.activity.attempt(content.attempt);
	const label = content.phase === "wait" && content.delayMs !== undefined
		? t.activity.retryingIn(formatDelay(content.delayMs))
		: t.activity.retrying;
	return <ChatActivity label={label} meta={attempt} detail={content.errorMessage} />;
}

function ToolGateActivity({ content }: { content: ToolGateContent }): null {
	useEffect(() => {
		setToolGatePending(content.toolCallId, content.pending);
	}, [content.toolCallId, content.pending]);
	return null;
}

/** Live retry rows disappear when the step finishes. */
export function RunActivity({ message }: { message: ActivityMessage }) {
	switch (message.activityType) {
		case "loom.retry": return <RetryActivity content={message.content as RetryContent} />;
		case "loom.tool_gate": return <ToolGateActivity content={message.content as ToolGateContent} />;
		default: return null;
	}
}

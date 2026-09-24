import { useDefaultRenderTool } from "@copilotkit/react-core/v2";

/** Register a chat renderer so tool results are visible in CopilotChat. */
export function ToolCallViews(): null {
	useDefaultRenderTool({
		render: ({ name, status, result }) => (
			<div className="tool-call">
				<div className="tool-call-head">
					<span className="tool-call-name">{name}</span>
					<span className="tool-call-status">{status === "complete" ? "done" : status}</span>
				</div>
				{status === "complete" && result ? (
					<pre className="tool-call-result">{formatToolResult(result)}</pre>
				) : null}
			</div>
		),
	}, []);
	return null;
}

function formatToolResult(result: string): string {
	try {
		return JSON.stringify(JSON.parse(result), null, 2);
	} catch {
		return result;
	}
}

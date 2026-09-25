import { useState } from "react";
import { useDefaultRenderTool } from "@copilotkit/react-core/v2";

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
	const [open, setOpen] = useState(false);
	const done = status === "complete";
	const body = formatToolBody(parameters, done ? result : undefined);
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
			{body ? (
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

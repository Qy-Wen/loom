import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface ToolCardProps {
	name: string;
	status?: ReactNode;
	parameters?: unknown;
	result?: unknown;
	resultContent?: ReactNode;
	actions?: ReactNode;
	actionError?: string | null;
	labels?: { arguments?: string; result?: string };
}

export function ToolCard({ name, status, parameters, result, resultContent, actions, actionError, labels }: ToolCardProps) {
	const bodyId = useId();
	const bodyRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [expandable, setExpandable] = useState(false);
	const expanded = expandable && open;
	const Header = expandable ? "button" : "div";
	const hasResult = result != null && result !== "";

	useEffect(() => {
		const body = bodyRef.current;
		const content = contentRef.current;
		if (!body || !content) return;
		const measure = () => {
			const limit = Number.parseFloat(getComputedStyle(body).getPropertyValue("--agui-tool-preview-height"));
			setExpandable(content.scrollHeight > limit + 1);
		};
		const observer = new ResizeObserver(measure);
		observer.observe(content);
		measure();
		return () => observer.disconnect();
	}, []);

	return <div className="agui-tool-card" data-expanded={expanded}>
		<Header
			className="agui-tool-header"
			type={expandable ? "button" : undefined}
			aria-controls={expandable ? bodyId : undefined}
			aria-expanded={expandable ? expanded : undefined}
			onClick={expandable ? () => setOpen((current) => !current) : undefined}
		>
			{expandable && <span className="agui-tool-chevron" aria-hidden="true" />}
			<span className="agui-tool-name">{name}</span>
			{status != null && <span className="agui-tool-status">{status}</span>}
		</Header>
		{actions}
		{actionError && <p className="agui-tool-error" role="alert">{actionError}</p>}
		<div
			id={bodyId}
			ref={bodyRef}
			className="agui-tool-body"
			data-preview={expandable && !expanded}
			onClick={expandable && !expanded ? (event) => {
				if (event.target instanceof Element && !event.target.closest("button, a, input, select, textarea, [role='button']")) setOpen(true);
			} : undefined}
		>
			<div className="agui-tool-content" ref={contentRef}>
				<div className="agui-tool-label">{labels?.arguments ?? "arguments"}</div>
				<pre className="agui-tool-arguments">{formatToolValue(parameters)}</pre>
				{(hasResult || resultContent != null) && (
					<div className="agui-tool-output">
						<div className="agui-tool-label">{labels?.result ?? "result"}</div>
						{hasResult && <pre className="agui-tool-result">{formatToolValue(result)}</pre>}
						{resultContent}
					</div>
				)}
			</div>
		</div>
	</div>;
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
		return JSON.stringify(value ?? {}, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface ToolCardProps {
	name: string;
	status?: ReactNode;
	state?: "waiting" | "running" | "done" | "failed";
	startedAt?: number;
	durationMs?: number;
	defaultOpen?: boolean;
	parameters?: unknown;
	result?: unknown;
	resultContent?: ReactNode;
	actions?: ReactNode;
	actionError?: string | null;
	labels?: {
		arguments?: string; result?: string; duration?: string; elapsed?: string; emptyResult?: string;
		copyArguments?: string; copyResult?: string; copied?: string; copyFailed?: string;
	};
}

export function ToolCard({ name, status, state, startedAt, durationMs, defaultOpen = false, parameters, result, resultContent, actions, actionError, labels }: ToolCardProps) {
	const [userOpen, setUserOpen] = useState<boolean>();
	const expanded = userOpen ?? defaultOpen;
	const resultText = result != null && result !== "" ? formatToolValue(result) : undefined;
	const feedback = { copied: labels?.copied ?? "Copied", failed: labels?.copyFailed ?? "Copy failed" };
	const showArguments = parameters !== undefined;
	const showResult = resultText !== undefined || resultContent != null || Boolean(labels?.emptyResult);
	return <div className="agui-tool-card" data-state={state}>
		<details open={expanded} onToggle={(event) => {
			if (event.currentTarget.open !== expanded) setUserOpen(event.currentTarget.open);
		}}>
			<summary className="agui-tool-header">
				<svg className="agui-tool-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m4.5 3 3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
				{state && <span className="agui-tool-dot" aria-hidden="true" />}
				<span className="agui-tool-name">{name}</span>
				{durationMs !== undefined ? <ToolTime durationMs={durationMs} label={labels?.duration ?? "Duration"} />
					: startedAt !== undefined && <RunningToolTime key={startedAt} startedAt={startedAt} label={labels?.elapsed ?? "Elapsed"} />}
				{status != null && <span className="agui-tool-status">{status}</span>}
			</summary>
			{(showArguments || showResult) && <div className="agui-tool-body">
				{showArguments && <ToolSection label={labels?.arguments ?? "Arguments"} copyLabel={labels?.copyArguments ?? "Copy tool arguments"}
					text={formatToolValue(parameters)} textClass="agui-tool-arguments" feedback={feedback} />}
				{showResult && <ToolSection label={labels?.result ?? "Result"}
					copyLabel={labels?.copyResult ?? "Copy tool result"} text={resultText} textClass="agui-tool-result" feedback={feedback}>
					{resultContent ?? (resultText === undefined && labels?.emptyResult && <p className="agui-tool-empty">{labels.emptyResult}</p>)}
				</ToolSection>}
			</div>}
		</details>
		{(actions != null || actionError) && <div className="agui-tool-actions">
			{actions}
			{actionError && <p className="agui-tool-error" role="alert">{actionError}</p>}
		</div>}
	</div>;
}

function ToolTime({ durationMs, label, fractionDigits = 1 }: { durationMs: number; label: string; fractionDigits?: 0 | 1 }) {
	const seconds = durationMs / 1000;
	return <time className="agui-tool-time" dateTime={`PT${seconds}S`} title={label}>{seconds.toFixed(fractionDigits)}s</time>;
}

function RunningToolTime({ startedAt, label }: { startedAt: number; label: string }) {
	const [seconds, setSeconds] = useState(() => Math.floor(elapsedMs(startedAt) / 1000));
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout>;
		const update = () => {
			const elapsed = elapsedMs(startedAt);
			setSeconds(Math.floor(elapsed / 1000));
			// Align ticks to the tool's start, even when the card mounts partway through a run.
			timer = setTimeout(update, 1000 - (elapsed % 1000));
		};
		update();
		return () => clearTimeout(timer);
	}, [startedAt]);
	return <ToolTime durationMs={seconds * 1000} label={label} fractionDigits={0} />;
}

function elapsedMs(startedAt: number): number {
	return Math.max(0, Math.round(performance.timeOrigin + performance.now() - startedAt));
}

function ToolSection({ label, copyLabel, text, textClass, feedback, children }: {
	label: string; copyLabel: string; text?: string; textClass: string;
	feedback: Record<"copied" | "failed", string>; children?: ReactNode;
}) {
	const id = useId();
	const target = useRef<HTMLPreElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const attempt = useRef(0);
	const [copyState, setCopyState] = useState<"copied" | "failed">();
	const nativeCommand = typeof HTMLButtonElement !== "undefined" && "commandForElement" in HTMLButtonElement.prototype;
	const copy = useCallback(async () => {
		if (!text) return;
		const current = ++attempt.current;
		let state: "copied" | "failed" = "copied";
		try { await navigator.clipboard.writeText(text); }
		catch { state = "failed"; }
		if (current !== attempt.current) return;
		clearTimeout(timer.current);
		setCopyState(state);
		timer.current = setTimeout(() => setCopyState(undefined), 1600);
	}, [text]);
	useEffect(() => {
		const pre = target.current;
		if (!pre || !nativeCommand) return;
		const command = (event: Event) => { if ((event as Event & { command: string }).command === "--copy-tool-text") void copy(); };
		pre.addEventListener("command", command);
		return () => pre.removeEventListener("command", command);
	}, [copy, nativeCommand]);
	useEffect(() => () => { attempt.current++; clearTimeout(timer.current); }, []);

	return <div className="agui-tool-section">
		<div className="agui-tool-label">
			{label}
			{text && <div className="agui-tool-copy" data-copy-state={copyState}>
				<button type="button" aria-label={copyLabel} data-tooltip={copyLabel}
					{...{ command: "--copy-tool-text", commandfor: id }} onClick={nativeCommand ? undefined : () => { void copy(); }}>
					<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						{copyState === "copied" ? <path d="m5 12 4 4L19 6" /> : <>
							<rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2" />
						</>}
					</svg>
				</button>
				<span className="agui-tool-copy-feedback" role="status">{copyState ? feedback[copyState] : ""}</span>
			</div>}
		</div>
		<div className="agui-tool-data">
			{text !== undefined && <pre id={id} ref={target} className={textClass}>{text}</pre>}
			{children}
		</div>
	</div>;
}

function formatToolValue(value: unknown): string {
	if (typeof value === "string") {
		try { return JSON.stringify(JSON.parse(value), null, 2); }
		catch { return value; }
	}
	try { return JSON.stringify(value ?? {}, null, 2) ?? String(value); }
	catch { return String(value); }
}

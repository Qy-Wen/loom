import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ProbeState = "idle" | "checking" | "ok" | "error";

interface SettingsSwitchProps {
	checked: boolean;
	disabled?: boolean;
	label: string;
	status: ProbeState;
	error?: string;
	onChange: (checked: boolean) => void;
}

export function SettingsSwitch({
	checked,
	disabled,
	label,
	status,
	error,
	onChange,
}: SettingsSwitchProps): React.JSX.Element {
	return (
		<span className="settings-slot-controls">
			<ProbeMark status={status} error={error} />
			<label className="settings-switch">
				<input
					type="checkbox"
					role="switch"
					checked={checked}
					disabled={disabled}
					aria-label={label}
					onChange={(event) => onChange(event.target.checked)}
				/>
				<span className="settings-switch-ui" aria-hidden="true" />
			</label>
		</span>
	);
}

function ProbeMark({ status, error }: { status: ProbeState; error?: string }): React.JSX.Element {
	if (status === "error") {
		return <ErrorProbe error={error?.trim() || "Connection failed"} />;
	}
	const label = status === "checking" ? "Checking connection" : status === "ok" ? "Connected" : "Not connected";
	return <span className={`settings-probe is-${status}`} title={label} aria-label={label} />;
}

function ErrorProbe({ error }: { error: string }): React.JSX.Element {
	const wrapRef = useRef<HTMLSpanElement>(null);
	const tipRef = useRef<HTMLDivElement>(null);
	const hideTimer = useRef<number>(undefined);
	const tipId = `settings-probe-tip-${useId().replace(/:/g, "")}`;
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [pos, setPos] = useState({ top: 0, right: 12, maxHeight: 240 });

	function place(): void {
		const rect = wrapRef.current?.getBoundingClientRect();
		if (!rect) return;
		const right = Math.max(12, window.innerWidth - rect.right);
		const below = window.innerHeight - rect.bottom - 12;
		if (below >= 120) {
			setPos({ top: rect.bottom + 6, right, maxHeight: Math.min(240, below) });
			return;
		}
		const height = Math.min(240, Math.max(96, rect.top - 12));
		setPos({ top: Math.max(12, rect.top - height - 6), right, maxHeight: height });
	}

	function show(): void {
		if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
		place();
		setOpen(true);
	}

	function hideSoon(): void {
		if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
		hideTimer.current = window.setTimeout(() => {
			setOpen(false);
			setCopied(false);
		}, 160);
	}

	useEffect(() => () => {
		if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
	}, []);

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(error);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	}

	return (
		<span
			ref={wrapRef}
			className="settings-probe-wrap"
			onMouseEnter={show}
			onMouseLeave={hideSoon}
		>
			<button
				type="button"
				className="settings-probe-error"
				aria-label="Connection error"
				aria-expanded={open}
				aria-describedby={open ? tipId : undefined}
				onFocus={show}
				onBlur={(event) => {
					if (event.relatedTarget instanceof Node && tipRef.current?.contains(event.relatedTarget)) return;
					hideSoon();
				}}
				onClick={show}
			>
				<ErrorIcon />
			</button>
			{open && createPortal(
				<div
					ref={tipRef}
					id={tipId}
					className="settings-probe-tip"
					role="tooltip"
					style={{ top: pos.top, right: pos.right, maxHeight: pos.maxHeight }}
					onMouseEnter={show}
					onMouseLeave={hideSoon}
				>
					<div className="settings-probe-tip-head">
						<span>Connection failed</span>
						<button
							type="button"
							className="settings-probe-copy"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => void copy()}
						>
							{copied ? "Copied" : "Copy"}
						</button>
					</div>
					<pre className="settings-probe-tip-text">{error}</pre>
				</div>,
				document.body,
			)}
		</span>
	);
}

function ErrorIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<circle cx="8" cy="8" r="7" fill="currentColor" />
			<path d="M8 4.3v5" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
			<circle cx="8" cy="11.5" r="1" fill="#fff" />
		</svg>
	);
}

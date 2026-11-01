import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../locale.tsx";
import { TOOLTIP_LEAVE_DELAY_MS } from "../components/tooltip-behavior.ts";

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
			<SettingsStatus status={status} error={error} />
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

export function SettingsStatus({ status, error, label, errorTitle, dotOnly = false }: {
	status: ProbeState;
	error?: string;
	label?: string;
	errorTitle?: string;
	dotOnly?: boolean;
}): React.JSX.Element {
	if (status === "error") {
		return <ErrorProbe error={error?.trim() || "Connection failed"} label={label} title={errorTitle} dotOnly={dotOnly} />;
	}
	const text = label ?? (status === "checking" ? "Checking connection" : status === "ok" ? "Connected" : "Not connected");
	return <span className={`settings-probe is-${status}`} title={text} aria-label={text} />;
}

function ErrorProbe({ error, label, title, dotOnly }: { error: string; label?: string; title?: string; dotOnly: boolean }): React.JSX.Element {
	const { t } = useLocale();
	const wrapRef = useRef<HTMLSpanElement>(null);
	const tipRef = useRef<HTMLDivElement>(null);
	const hideTimer = useRef<number>(undefined);
	const tipId = `settings-probe-tip-${useId().replace(/:/g, "")}`;
	const [open, setOpen] = useState(false);
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

	function hide(): void {
		if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
		hideTimer.current = undefined;
		setOpen(false);
	}

	function hideSoon(): void {
		if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
		hideTimer.current = window.setTimeout(hide, TOOLTIP_LEAVE_DELAY_MS);
	}

	useEffect(() => () => {
		if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
	}, []);

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(error);
		} catch {
			// Clipboard access may be unavailable.
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
				className={dotOnly ? "settings-probe-error settings-probe-error-dot" : "settings-probe-error"}
				aria-label={label ?? t.settings.connectionError}
				aria-expanded={open}
				aria-describedby={open ? tipId : undefined}
				onFocus={show}
				onBlur={(event) => {
					if (event.relatedTarget instanceof Node && tipRef.current?.contains(event.relatedTarget)) return;
					hideSoon();
				}}
				onClick={hide}
			>
				{dotOnly ? <span className="settings-probe is-error" aria-hidden="true" /> : <ErrorIcon />}
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
						<span>{title ?? t.settings.connectionFailed}</span>
						<button
							type="button"
							className="settings-probe-copy"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => { void copy(); hide(); }}
						>
							{t.common.copy}
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
			<path d="M8 4.3v5" fill="none" style={{ stroke: "var(--lm-text-inverse)" }} strokeWidth="1.7" strokeLinecap="round" />
			<circle cx="8" cy="11.5" r="1" style={{ fill: "var(--lm-text-inverse)" }} />
		</svg>
	);
}

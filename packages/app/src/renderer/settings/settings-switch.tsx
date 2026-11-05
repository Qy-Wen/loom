import { useRef } from "react";
import { useLocale } from "../locale.tsx";
import { useTooltip } from "../components/tooltip.tsx";

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
	return <span className={`settings-probe is-${status}`} data-tooltip={text} aria-label={text} />;
}

function ErrorProbe({ error, label, title, dotOnly }: { error: string; label?: string; title?: string; dotOnly: boolean }): React.JSX.Element {
	const { t } = useLocale();
	const buttonRef = useRef<HTMLButtonElement>(null);
	const tooltip = useTooltip();
	const open = tooltip.anchor === buttonRef.current;
	function show(immediate = false): void {
		if (!buttonRef.current) return;
		tooltip.show(buttonRef.current, <>
			<div className="settings-probe-tip-head">
				<span>{title ?? t.settings.connectionFailed}</span>
				<button type="button" className="settings-probe-copy"
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => { void copy(); tooltip.dismiss(); }}>
					{t.common.copy}
				</button>
			</div>
			<pre className="settings-probe-tip-text">{error}</pre>
		</>, { immediate, interactive: true, className: "settings-probe-tip" });
	}

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(error);
		} catch {
			// Clipboard access may be unavailable.
		}
	}

	return (
		<span className="settings-probe-wrap" data-tooltip-custom
			onPointerEnter={() => show()} onPointerLeave={tooltip.leave}>
			<button ref={buttonRef} type="button"
				className={dotOnly ? "settings-probe-error settings-probe-error-dot" : "settings-probe-error"}
				aria-label={label ?? t.settings.connectionError} aria-expanded={open}
				onFocus={() => show(true)}
				onBlur={(event) => { if (!tooltip.contains(event.relatedTarget)) tooltip.leave(); }}
				onClick={tooltip.dismiss}>
				{dotOnly ? <span className="settings-probe is-error" aria-hidden="true" /> : <ErrorIcon />}
			</button>
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

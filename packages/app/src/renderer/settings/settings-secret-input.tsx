import { useState, type InputHTMLAttributes } from "react";
import { useLocale } from "../locale.tsx";

/** The secret stays masked on mount; revealing never changes its value or submits the form. */
export function SettingsSecretInput({ label, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string }): React.JSX.Element {
	const { t } = useLocale();
	const [visible, setVisible] = useState(false);
	return (
		<div className="settings-secret-input">
			<input {...props} type={visible ? "text" : "password"} aria-label={label} />
			<button
				className="settings-secret-toggle"
				type="button"
				disabled={props.disabled}
				aria-label={visible ? t.settings.hideSecret(label) : t.settings.showSecret(label)}
				aria-pressed={visible}
				onClick={() => setVisible(!visible)}
			>
				<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
					<circle cx="12" cy="12" r="3" />
					{visible && <path d="m3 3 18 18" />}
				</svg>
			</button>
		</div>
	);
}

import { useState } from "react";
import { commandAllowId, commandAllowLabel, type CommandAllow } from "@loom/agent/tool-permission";
import { useLocale } from "../locale.tsx";
import { setCommandAllows, useCommandAllows } from "../panel/command-allows.ts";
import { SettingsInstructions } from "./settings-instructions.tsx";

interface SettingsAgentProps {
	sandboxEnabled: boolean;
	instructions: string;
	onSandboxChange: (enabled: boolean) => void;
	onInstructionsChange: (value: string) => void;
}

export function SettingsAgent({
	sandboxEnabled,
	instructions,
	onSandboxChange,
	onInstructionsChange,
}: SettingsAgentProps): React.JSX.Element {
	const { t } = useLocale();
	const remembered = useCommandAllows();
	const [forgetError, setForgetError] = useState<string | null>(null);

	async function forget(allow: CommandAllow): Promise<void> {
		setForgetError(null);
		try {
			setCommandAllows(await window.loom.removeCommandAllow(allow));
		} catch (cause) {
			setForgetError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	return (
		<div className="settings-agent">
			<section className="settings-slot" aria-label={t.settings.sandbox}>
				<div className="settings-slot-head">
					<span className="settings-slot-title">{t.settings.sandbox}</span>
					<label className="settings-switch">
						<input
							type="checkbox"
							role="switch"
							checked={sandboxEnabled}
							aria-label={t.settings.sandbox}
							onChange={(event) => onSandboxChange(event.target.checked)}
						/>
						<span className="settings-switch-ui" aria-hidden="true" />
					</label>
				</div>
				<p>{t.settings.sandboxNote}</p>
			</section>
			<section className="settings-allows" aria-label={t.settings.allows}>
				<span className="settings-slot-title">{t.settings.allows}</span>
				<p className="settings-agent-note">{t.settings.allowsNote}</p>
				{remembered.libraryOpen ? (
					remembered.allows.length === 0 ? <p className="settings-agent-note">{t.settings.allowsEmpty}</p> : (
						<ul className="settings-allow-list">
							{remembered.allows.map((allow) => {
								const label = commandAllowLabel(allow);
								return (
									<li key={commandAllowId(allow)} className="settings-allow-row">
										<span className="settings-allow-label" title={label}>{label}</span>
										<button type="button" onClick={() => { void forget(allow); }}>{t.common.remove}</button>
									</li>
								);
							})}
						</ul>
					)
				) : <p className="settings-agent-note">{t.settings.allowsNeedLibrary}</p>}
				{forgetError ? <p className="tool-call-gate-error">{forgetError}</p> : null}
			</section>
			<div className="settings-agent-instructions">
				<span className="settings-slot-title">{t.settings.instructions}</span>
				<p className="settings-agent-note">{t.settings.instructionsNote}</p>
				<SettingsInstructions value={instructions} onChange={onInstructionsChange} />
			</div>
		</div>
	);
}

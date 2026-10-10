import { useLocale } from "../locale.tsx";
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
			<div className="settings-agent-instructions">
				<span className="settings-slot-title">{t.settings.instructions}</span>
				<p className="settings-agent-note">{t.settings.instructionsNote}</p>
				<SettingsInstructions value={instructions} onChange={onInstructionsChange} />
			</div>
		</div>
	);
}

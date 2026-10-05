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
	return (
		<div className="settings-agent">
			<section className="settings-slot" aria-label="Process sandbox">
				<div className="settings-slot-head">
					<span className="settings-slot-title">Process sandbox</span>
					<label className="settings-switch">
						<input
							type="checkbox"
							role="switch"
							checked={sandboxEnabled}
							aria-label="Process sandbox"
							onChange={(event) => onSandboxChange(event.target.checked)}
						/>
						<span className="settings-switch-ui" aria-hidden="true" />
					</label>
				</div>
				<p>
					On wraps bash, ffmpeg, and ffprobe: they can write the open library and the temp directory, cannot read the user profile, and have no network. Off, or Full permission, runs them directly. The next command picks this up.
				</p>
			</section>
			<div className="settings-agent-instructions">
				<span className="settings-slot-title">Instructions</span>
				<p className="settings-agent-note">
					Saved in the app as AGENTS.md. The next session appends this to the system prompt. An empty box adds nothing. This session keeps the text it started with.
				</p>
				<SettingsInstructions value={instructions} onChange={onInstructionsChange} />
			</div>
		</div>
	);
}

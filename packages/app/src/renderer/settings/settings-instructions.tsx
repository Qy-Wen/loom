import { INSTRUCTIONS_CHAR_LIMIT, instructionCharacterCount } from "../../shared/agent-instructions.ts";

interface SettingsInstructionsProps {
	value: string;
	onChange: (value: string) => void;
}

export function SettingsInstructions({ value, onChange }: SettingsInstructionsProps): React.JSX.Element {
	const count = instructionCharacterCount(value);
	const over = count > INSTRUCTIONS_CHAR_LIMIT;
	return (
		<label className="settings-instructions">
			<textarea
				value={value}
				spellCheck={false}
				aria-label="Agent instructions"
				onChange={(event) => onChange(event.target.value)}
			/>
			<span className={over ? "settings-instructions-count is-over" : "settings-instructions-count"}>
				{count}/{INSTRUCTIONS_CHAR_LIMIT}
			</span>
		</label>
	);
}

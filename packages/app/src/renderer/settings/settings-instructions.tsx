import { INSTRUCTIONS_CHAR_LIMIT, instructionCharacterCount } from "../../shared/agent-instructions.ts";
import { useLocale } from "../locale.tsx";

interface SettingsInstructionsProps {
	value: string;
	onChange: (value: string) => void;
}

export function SettingsInstructions({ value, onChange }: SettingsInstructionsProps): React.JSX.Element {
	const { t } = useLocale();
	const count = instructionCharacterCount(value);
	const over = count > INSTRUCTIONS_CHAR_LIMIT;
	return (
		<label className="settings-instructions">
			<textarea
				value={value}
				spellCheck={false}
				aria-label={t.settings.instructionsLabel}
				onChange={(event) => onChange(event.target.value)}
			/>
			<span className={over ? "settings-instructions-count is-over" : "settings-instructions-count"}>
				{count}/{INSTRUCTIONS_CHAR_LIMIT}
			</span>
		</label>
	);
}

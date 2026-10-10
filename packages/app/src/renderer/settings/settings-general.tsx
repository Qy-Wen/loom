import type { AppLanguageChoice, GeneralSettings } from "../../shared/general-settings.ts";
import { useLocale } from "../locale.tsx";

const CHOICES: Array<{ id: AppLanguageChoice; label: "followSystem" | "english" | "chinese" }> = [
	{ id: "system", label: "followSystem" },
	{ id: "en", label: "english" },
	{ id: "zh-CN", label: "chinese" },
];

interface SettingsGeneralProps {
	value: GeneralSettings;
	onChange: (patch: Partial<GeneralSettings>) => void;
}

export function SettingsGeneral({ value, onChange }: SettingsGeneralProps): React.JSX.Element {
	const { t } = useLocale();
	return (
		<div className="settings-form">
			<section className="settings-slot" aria-label={t.settings.language}>
				<div className="settings-slot-head">
					<span className="settings-slot-title">{t.settings.language}</span>
				</div>
				<div className="settings-kind" role="radiogroup" aria-label={t.settings.languageLabel}>
					{CHOICES.map((choice) => (
						<label key={choice.id} className={value.language === choice.id ? "is-active" : undefined}>
							<input
								type="radio"
								name="app-language"
								checked={value.language === choice.id}
								onChange={() => onChange({ language: choice.id })}
							/>
							{t.settings[choice.label]}
						</label>
					))}
				</div>
				<p>{t.settings.languageNote}</p>
			</section>
			<section className="settings-slot" aria-label={t.settings.startup}>
				<div className="settings-slot-head">
					<span className="settings-slot-title">{t.settings.reopen}</span>
					<label className="settings-switch">
						<input
							type="checkbox"
							role="switch"
							checked={value.reopenLastLibrary}
							aria-label={t.settings.reopen}
							onChange={(event) => onChange({ reopenLastLibrary: event.target.checked })}
						/>
						<span className="settings-switch-ui" aria-hidden="true" />
					</label>
				</div>
				<p>{t.settings.reopenNote}</p>
			</section>
		</div>
	);
}

export const APP_LANGUAGE_CHOICES = ["system", "en", "zh-CN"] as const;

export type AppLanguageChoice = (typeof APP_LANGUAGE_CHOICES)[number];

export type AppLanguage = "en" | "zh-CN";

export const APP_APPEARANCE_CHOICES = ["system", "light", "dark"] as const;

export type AppAppearanceChoice = (typeof APP_APPEARANCE_CHOICES)[number];

export type AppTheme = "light" | "dark";

export interface GeneralSettings {
	language: AppLanguageChoice;
	/** Light or dark interface; "system" follows the operating system. */
	appearance: AppAppearanceChoice;
	reopenLastLibrary: boolean;
	/** Offer web_search and web_fetch when a DeepSeek API key is configured. */
	webTools: boolean;
}

export function defaultGeneralSettings(): GeneralSettings {
	return { language: "system", appearance: "system", reopenLastLibrary: true, webTools: true };
}

export function parseGeneralSettings(value: unknown): GeneralSettings {
	const fallback = defaultGeneralSettings();
	if (!value || typeof value !== "object") return fallback;
	const record = value as { language?: unknown; appearance?: unknown; reopenLastLibrary?: unknown; webTools?: unknown };
	return {
		language: isLanguageChoice(record.language) ? record.language : fallback.language,
		appearance: isAppearanceChoice(record.appearance) ? record.appearance : fallback.appearance,
		reopenLastLibrary: typeof record.reopenLastLibrary === "boolean" ? record.reopenLastLibrary : fallback.reopenLastLibrary,
		webTools: typeof record.webTools === "boolean" ? record.webTools : fallback.webTools,
	};
}

export function resolveAppLanguage(choice: AppLanguageChoice, systemLanguage: string): AppLanguage {
	if (choice === "en" || choice === "zh-CN") return choice;
	return systemLanguage.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** The theme to paint. `systemDark` is whether the operating system is in dark mode. */
export function resolveAppTheme(choice: AppAppearanceChoice, systemDark: boolean): AppTheme {
	if (choice === "light" || choice === "dark") return choice;
	return systemDark ? "dark" : "light";
}

function isAppearanceChoice(value: unknown): value is AppAppearanceChoice {
	return value === "system" || value === "light" || value === "dark";
}

function isLanguageChoice(value: unknown): value is AppLanguageChoice {
	return value === "system" || value === "en" || value === "zh-CN";
}

export function parseGeneralSettingsPatch(value: unknown): Partial<GeneralSettings> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("General settings must be an object");
	const parsed = parseGeneralSettings(value);
	return {
		...("language" in value ? { language: parsed.language } : {}),
		...("appearance" in value ? { appearance: parsed.appearance } : {}),
		...("reopenLastLibrary" in value ? { reopenLastLibrary: parsed.reopenLastLibrary } : {}),
		...("webTools" in value ? { webTools: parsed.webTools } : {}),
	};
}

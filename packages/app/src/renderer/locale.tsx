import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { resolveAppLanguage, type AppLanguage, type AppLanguageChoice } from "../shared/general-settings.ts";
import { messagesFor, type Messages } from "../shared/locale.ts";

interface LocaleValue {
	language: AppLanguage;
	t: Messages;
	commitLanguage: (choice: AppLanguageChoice) => void;
}

const LocaleContext = createContext<LocaleValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }): React.JSX.Element {
	const [choice, setChoice] = useState<AppLanguageChoice>("system");
	const language = resolveAppLanguage(choice, navigator.language);
	const t = messagesFor(language);

	useEffect(() => {
		void window.loom.getGeneralSettings().then((settings) => {
			setChoice(settings.language);
		}).catch(() => undefined);
	}, []);

	useEffect(() => {
		document.documentElement.lang = language;
	}, [language]);

	const commitLanguage = useCallback((next: AppLanguageChoice) => setChoice(next), []);

	const value = useMemo(
		() => ({ language, t, commitLanguage }),
		[language, t, commitLanguage],
	);

	return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleValue {
	const value = useContext(LocaleContext);
	if (!value) throw new Error("LocaleProvider is missing");
	return value;
}

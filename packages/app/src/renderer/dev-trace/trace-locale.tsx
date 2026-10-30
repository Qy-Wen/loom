import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { resolveAppLanguage, type AppLanguage, type AppLanguageChoice } from "../../shared/general-settings.ts";
import { traceMessagesFor, type TraceMessages } from "./trace-messages.ts";

type TraceLocale = { language: AppLanguage; t: TraceMessages };
const Context = createContext<TraceLocale | null>(null);

/** Follows the app's interface language, like the main window's LocaleProvider, through this window's own preload. */
export function TraceLocaleProvider({ children }: { children: ReactNode }): React.JSX.Element {
	const [choice, setChoice] = useState<AppLanguageChoice>("system");
	useEffect(() => {
		let disposed = false;
		const reload = () => { void window.loomDev.getLanguage().then((next) => { if (!disposed) setChoice(next); }).catch(() => undefined); };
		reload();
		const unsubscribe = window.loomDev.onLanguageChanged(reload);
		return () => { disposed = true; unsubscribe(); };
	}, []);
	const language = resolveAppLanguage(choice, navigator.language);
	useEffect(() => { document.documentElement.lang = language; }, [language]);
	const value = useMemo(() => ({ language, t: traceMessagesFor(language) }), [language]);
	return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTraceLocale(): TraceLocale {
	const value = useContext(Context);
	if (!value) throw new Error("TraceLocaleProvider is missing");
	return value;
}

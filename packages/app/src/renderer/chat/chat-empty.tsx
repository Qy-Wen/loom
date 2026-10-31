import { useEffect, useState } from "react";
import { useLocale } from "../locale.tsx";
import { useChatSession } from "./chat-context.ts";

/**
 * Shown in an empty conversation. With a usable model it offers a few starting points that fill the composer
 * (they never send on their own). Without one it points to Settings, since nothing else can work yet.
 */
export function ChatEmptyState(): React.JSX.Element | null {
	const { t } = useLocale();
	const { threadId, requestDraft, onOpenSettings } = useChatSession();
	const [hasModel, setHasModel] = useState<boolean | null>(null);

	useEffect(() => {
		let cancelled = false;
		const load = () => {
			void window.loom.getChatSettings().then((view) => {
				if (!cancelled) setHasModel(view.models.some((row) => row.enabled && row.available));
			}).catch(() => { if (!cancelled) setHasModel(null); });
		};
		load();
		const stop = window.loom.onChatSettingsChanged(load);
		return () => { cancelled = true; stop(); };
	}, []);

	// Unknown yet, or the lookup failed: show nothing rather than flash the wrong state.
	if (hasModel === null) return null;

	if (!hasModel) {
		return (
			<div className="chat-empty" data-testid="chat-empty">
				<h3 className="chat-empty-title">{t.chat.emptyNoModelTitle}</h3>
				<p className="chat-empty-hint">{t.chat.emptyNoModelHint}</p>
				<button type="button" className="chat-empty-action" onClick={onOpenSettings}>{t.chat.emptyOpenSettings}</button>
			</div>
		);
	}

	return (
		<div className="chat-empty" data-testid="chat-empty">
			<h3 className="chat-empty-title">{t.chat.emptyTitle}</h3>
			<p className="chat-empty-hint">{t.chat.emptyHint}</p>
			<ul className="chat-empty-suggestions">
				{t.chat.emptySuggestions.map((text) => (
					<li key={text}>
						<button type="button" className="chat-empty-suggestion" onClick={() => requestDraft({ threadId, text })}>{text}</button>
					</li>
				))}
			</ul>
		</div>
	);
}

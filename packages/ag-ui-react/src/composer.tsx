import { useId, useState } from "react";

export function isImeComposing(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
	return event.isComposing || event.keyCode === 229;
}

export interface MessageComposerProps {
	onSend: (text: string) => void;
	onStop?: () => void;
	isRunning?: boolean;
	labels?: { message?: string; send?: string; stop?: string };
}

export function MessageComposer({ onSend, onStop, isRunning, labels }: MessageComposerProps) {
	const [draft, setDraft] = useState("");
	const id = useId();
	return <form className="agui-composer" onSubmit={(event) => {
		event.preventDefault();
		if (isRunning || !draft.trim()) return;
		onSend(draft);
		setDraft("");
	}}>
		<label htmlFor={id}>{labels?.message ?? "Message"}</label>
		<textarea id={id} rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
			if (event.key !== "Enter" || event.shiftKey || isImeComposing(event.nativeEvent)) return;
			event.preventDefault();
			event.currentTarget.form?.requestSubmit();
		}} />
		{isRunning && onStop
			? <button type="button" onClick={onStop}>{labels?.stop ?? "Stop"}</button>
			: <button type="submit" disabled={isRunning || !draft.trim()}>{labels?.send ?? "Send"}</button>}
	</form>;
}

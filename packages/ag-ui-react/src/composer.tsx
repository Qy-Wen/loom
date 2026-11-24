import { useId, useState, type ReactNode } from "react";

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

export interface ComposerFormProps {
	editor: ReactNode;
	leading?: ReactNode;
	controls?: ReactNode;
	mode?: "compose" | "edit";
	onSubmit: () => void;
	submitDisabled?: boolean;
	onStop?: () => void;
	onCancel?: () => void;
	cancelDisabled?: boolean;
	labels?: { send?: string; stop?: string; cancel?: string };
}

/** A controlled form for a host-supplied editor and toolbar controls. */
export function ComposerForm({ editor, leading, controls, mode = "compose", onSubmit, submitDisabled, onStop, onCancel, cancelDisabled, labels }: ComposerFormProps) {
	const composing = mode === "compose";
	const label = onStop ? labels?.stop ?? "Stop" : labels?.send ?? "Send";
	return <form
		className="agui-chat-composer"
		data-mode={mode}
		data-testid={composing ? "chat-composer" : undefined}
		onSubmit={(event) => {
			event.preventDefault();
			onSubmit();
		}}
	>
		<div className="agui-chat-composer-editor">{editor}</div>
		<div className="agui-chat-composer-toolbar">
			{leading && <div className="agui-chat-composer-leading">{leading}</div>}
			{composing ? <div className="agui-chat-composer-controls">{controls}</div> : controls}
			<div className="agui-chat-composer-actions">
				{onCancel && <button
					type="button"
					className="agui-chat-composer-cancel"
					aria-label={labels?.cancel ?? "Cancel"}
					data-tooltip={labels?.cancel ?? "Cancel"}
					disabled={cancelDisabled}
					onClick={onCancel}
				>
					<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M18 6 6 18M6 6l12 12" />
					</svg>
				</button>}
				<button
					type={onStop ? "button" : "submit"}
					className="agui-chat-composer-submit"
					data-testid={composing ? "chat-send-button" : undefined}
					aria-label={label}
					data-tooltip={label}
					disabled={!onStop && submitDisabled}
					onClick={onStop}
				>
					{onStop
						? <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
						: <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 7-7 7 7M12 19V5" /></svg>}
				</button>
			</div>
		</div>
	</form>;
}

import { useState, type ReactNode } from "react";

export function MessageRow({ role, text, copyLabel, actions, children }: {
	role: "user" | "assistant";
	text: string;
	copyLabel: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return <article className={`agui-chat-message agui-chat-${role}`} data-testid={`chat-${role}-message`}>
		{role === "user" ? <div className="agui-chat-bubble">{children}</div> : children}
		<div className="agui-chat-toolbar" data-testid={`chat-${role}-toolbar`}>
			<button type="button" aria-label={copyLabel} data-tooltip={copyLabel} data-testid={role === "user" ? "chat-user-copy-button" : "chat-copy-button"} onClick={() => { void navigator.clipboard?.writeText(text).catch(() => {}); }}>
				<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2" />
				</svg>
			</button>
			{actions}
		</div>
	</article>;
}

export function ReasoningRow({ label, children }: { label: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return <div className="agui-chat-reasoning">
		<button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{label}<span aria-hidden="true">›</span></button>
		{open && children}
	</div>;
}

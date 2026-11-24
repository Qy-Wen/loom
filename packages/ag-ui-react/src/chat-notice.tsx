export interface ChatActivityProps {
	label: string;
	meta?: string;
	detail?: string;
	output?: string;
}

export function ChatActivity({ label, meta, detail, output }: ChatActivityProps) {
	return <div className="agui-chat-activity" role="status">
		<div className="agui-chat-activity-header">
			<span className="agui-chat-activity-label">{label}</span>
			{meta && <span className="agui-chat-activity-meta">{meta}</span>}
		</div>
		{detail && <p className="agui-chat-activity-detail">{detail}</p>}
		{output && <pre className="agui-chat-activity-output">{output}</pre>}
	</div>;
}

export interface ChatErrorProps {
	label?: string;
	message: string;
}

export function ChatError({ label, message }: ChatErrorProps) {
	return <div className="agui-chat-error" role="alert">
		{label && <div className="agui-chat-error-label">{label}</div>}
		<p className="agui-chat-error-body">{message}</p>
	</div>;
}

import { useEffect, useRef, useState } from "react";

interface CopyableErrorProps {
	text: string;
}

export function CopyableError({ text }: CopyableErrorProps): React.JSX.Element {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number>(undefined);

	useEffect(() => () => {
		if (timer.current !== undefined) window.clearTimeout(timer.current);
	}, []);

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			if (timer.current !== undefined) window.clearTimeout(timer.current);
			timer.current = window.setTimeout(() => setCopied(false), 1500);
		} catch {
			setCopied(false);
		}
	}

	return (
		<span className="copyable-error">
			<span className="copyable-error-text" title={text}>{text}</span>
			<button
				type="button"
				className="text-button copyable-error-copy"
				onClick={() => void copy()}
			>
				{copied ? "Copied" : "Copy"}
			</button>
		</span>
	);
}

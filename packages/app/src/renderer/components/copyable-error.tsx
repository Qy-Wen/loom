import { useEffect, useRef, useState } from "react";
import { useLocale } from "../locale.tsx";

interface CopyableErrorProps {
	text: string;
}

export function CopyableError({ text }: CopyableErrorProps): React.JSX.Element {
	const { t } = useLocale();
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
			<span className="copyable-error-text" data-tooltip={text}>{text}</span>
			<button
				type="button"
				className="text-button copyable-error-copy"
				onClick={() => void copy()}
			>
				{copied ? t.common.copied : t.common.copy}
			</button>
		</span>
	);
}

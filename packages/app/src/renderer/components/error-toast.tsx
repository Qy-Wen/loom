import { useEffect, useRef } from "react";
import { useLocale } from "../locale.tsx";
import { CopyableError } from "./copyable-error.tsx";

const TOAST_MS = 5000;

export function toastMessage(text: string): string {
	const message = text
		.replace(/^Error invoking remote method '[^']+':\s*/i, "")
		.replace(/^Error:\s*/, "")
		.trim();
	return message || text;
}

interface ErrorToastProps {
	text: string;
	onDismiss: () => void;
	autoDismiss?: boolean;
}

export function ErrorToast({ text, onDismiss, autoDismiss = true }: ErrorToastProps): React.JSX.Element {
	const { t } = useLocale();
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	useEffect(() => {
		if (!autoDismiss) return;
		const timer = window.setTimeout(() => onDismissRef.current(), TOAST_MS);
		return () => window.clearTimeout(timer);
	}, [text, autoDismiss]);

	return (
		<div className="error-toast" role="status">
			<CopyableError text={toastMessage(text)} />
			<button type="button" className="error-toast-dismiss" aria-label={t.app.dismiss} onClick={onDismiss}>×</button>
		</div>
	);
}

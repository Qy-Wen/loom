import { useEffect, useRef, useState } from "react";
import type { LoomContextUsage } from "@loom/agent";
import { useLocale } from "../locale.tsx";

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

/** Context usage as a ring. The percent and window appear only after a click. */
export function ContextIndicator({ context }: { context: LoomContextUsage | null }): React.JSX.Element | null {
	const { t } = useLocale();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("pointerdown", onPointer);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onPointer);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);
	if (!context) return null;
	const ratio = context.percent === null ? 0 : Math.min(100, Math.max(0, context.percent)) / 100;
	const radius = 6;
	const circumference = 2 * Math.PI * radius;
	const label = context.percent !== null
		? `~${context.percent.toFixed(1)}% / ${formatTokens(context.window)}`
		: `? / ${formatTokens(context.window)}`;
	return (
		<div className="session-context-usage" ref={rootRef}>
			{open && <span className="session-context-value">{label}</span>}
			<button
				type="button"
				className="session-context-ring"
				aria-label={t.chat.contextUsage}
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
			>
				<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
					<circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.25" />
					<circle
						cx="8"
						cy="8"
						r={radius}
						fill="none"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeDasharray={`${circumference * ratio} ${circumference}`}
						transform="rotate(-90 8 8)"
					/>
				</svg>
			</button>
		</div>
	);
}

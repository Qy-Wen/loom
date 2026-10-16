import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LoomSessionModel } from "@loom/agent";
import type { ChatModelView } from "../../shared/chat-models.ts";
import { useLocale } from "../locale.tsx";

type ModelChoice = {
	provider: string;
	modelId: string;
	label: string;
	thinkingLevels: string[];
	available: boolean;
};

/** Per-conversation model/thinking picker in the composer toolbar. Applies from the next request. */
export function ChatModelSelect({
	sessionId,
	model,
	onChange,
	disabled,
}: {
	sessionId: string;
	model: LoomSessionModel | undefined;
	/** Notified with the refreshed record after a selection commits. */
	onChange: () => void;
	disabled: boolean;
}): React.JSX.Element | null {
	const { t } = useLocale();
	const [models, setModels] = useState<ModelChoice[] | null>(null);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

	useEffect(() => {
		let cancelled = false;
		const load = () => {
			void window.loom.getChatSettings().then((view) => {
				if (cancelled) return;
				setModels(view.models.map((row): ModelChoice => ({
					provider: row.provider,
					modelId: row.id,
					label: `${row.name} (${row.provider})`,
					thinkingLevels: row.thinkingLevels,
					available: row.available,
				})));
			}).catch(() => { if (!cancelled) setModels([]); });
		};
		load();
		const stop = window.loom.onChatSettingsChanged(load);
		return () => { cancelled = true; stop(); };
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		const place = () => {
			const rect = buttonRef.current?.getBoundingClientRect();
			if (!rect) return;
			setMenuStyle({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
		};
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			const target = event.target as Node;
			if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
			setOpen(false);
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

	if (!models) return null;
	const current = model ? models.find((row) => row.provider === model.provider && row.modelId === model.modelId) : undefined;
	// The provider runtime is absent (no configured Chat) — hide rather than block the toolbar.
	if (!model && models.length === 0) return null;
	const label = current
		? current.label
		: model
			? `${model.provider} / ${model.modelId}`
			: t.settings.chat.defaultModel;

	async function choose(next: ModelChoice): Promise<void> {
		setOpen(false);
		if (current && next.provider === current.provider && next.modelId === current.modelId) return;
		setError(null);
		try {
			// Keep the current thinking level when the new model supports it; otherwise reset.
			const keep = model?.thinkingLevel && next.thinkingLevels.includes(model.thinkingLevel) ? model.thinkingLevel : undefined;
			await window.loom.setSessionModel(sessionId, { provider: next.provider, modelId: next.modelId, ...(keep ? { thinkingLevel: keep } : {}) });
			onChange();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function chooseThinking(level: string): Promise<void> {
		setOpen(false);
		if (!model) return;
		setError(null);
		try {
			await window.loom.setSessionModel(sessionId, { provider: model.provider, modelId: model.modelId, ...(level !== "off" ? { thinkingLevel: level } : {}) });
			onChange();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	const thinking = current && model?.thinkingLevel && current.thinkingLevels.length > 1;

	return (
		<div className="session-model-select" ref={rootRef}>
			{error && <span className="session-model-error" role="alert">{t.chat.modelChangeFailed}</span>}
			<button
				ref={buttonRef}
				type="button"
				aria-label={t.chat.modelSelect}
				aria-haspopup="listbox"
				aria-expanded={open}
				disabled={disabled}
				title={label}
				onClick={() => {
					if (open) { setOpen(false); return; }
					const rect = buttonRef.current?.getBoundingClientRect();
					if (rect) setMenuStyle({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
					setOpen(true);
				}}
			>
				<span className="session-model-label">{label}</span>
				<Chevron />
			</button>
			{thinking && (
				<button
					type="button"
					aria-label={t.chat.thinkingSelect}
					disabled={disabled}
					onClick={() => void cycleThinking()}
				>
					<span>{model!.thinkingLevel}</span>
				</button>
			)}
			{open && createPortal(
				<div
					ref={menuRef}
					className="session-permission-menu session-model-menu"
					role="listbox"
					aria-label={t.chat.modelSelect}
					style={menuStyle}
				>
					{models.map((row) => (
						<button
							key={`${row.provider}:${row.modelId}`}
							type="button"
							role="option"
							aria-selected={row.provider === model?.provider && row.modelId === model?.modelId}
							disabled={!row.available}
							onClick={() => { void choose(row); }}
						>
							{row.available ? row.label : t.chat.modelUnavailable(row.label)}
						</button>
					))}
					{models.length === 0 && <span className="session-model-empty">{t.settings.chat.noModels}</span>}
				</div>,
				document.body,
			)}
		</div>
	);

	async function cycleThinking(): Promise<void> {
		if (!model || !current) return;
		const order = ["off", ...current.thinkingLevels.filter((level) => level !== "off")];
		const index = order.indexOf(model.thinkingLevel ?? "off");
		const next = order[(index + 1) % order.length] ?? "off";
		await chooseThinking(next);
	}
}

function Chevron(): React.JSX.Element {
	return (
		<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
			<path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

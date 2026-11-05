import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { LoomSessionModel } from "@loom/agent";
import type { ChatThinkingLevel } from "@loom/agent/chat-models";
import { useLocale } from "../locale.tsx";
import { MenuCheck, MenuChevron } from "./composer-menu-icons.tsx";
import { composerMenuPosition } from "./composer-menu-position.ts";

type ModelChoice = {
	provider: string;
	modelId: string;
	label: string;
	thinkingLevels: ChatThinkingLevel[];
};
type ThinkingMenu = { model: ModelChoice; anchor: HTMLButtonElement; focus: boolean };

/** Move within one menu; the submenu owns its own keyboard navigation. */
function navigateMenu(event: KeyboardEvent<HTMLDivElement>): void {
	const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
	if (!items.length) return;
	const index = items.indexOf(document.activeElement as HTMLButtonElement);
	let next: number;
	switch (event.key) {
		case "ArrowDown": next = (index + 1) % items.length; break;
		case "ArrowUp": next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length; break;
		case "Home": next = 0; break;
		case "End": next = items.length - 1; break;
		default: return;
	}
	event.preventDefault();
	items[next]?.focus();
}

/** Controlled picker, also used for an unsaved history-edit model choice. */
export function ChatModelSelect({ model, onChange, disabled }: {
	model: LoomSessionModel | undefined;
	onChange: (model: LoomSessionModel) => void | Promise<void>;
	disabled: boolean;
}): React.JSX.Element | null {
	const { t } = useLocale();
	const menuId = useId();
	const [models, setModels] = useState<ModelChoice[] | null>(null);
	const [open, setOpen] = useState(false);
	const [submenu, setSubmenu] = useState<ThinkingMenu | null>(null);
	const [error, setError] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const submenuRef = useRef<HTMLDivElement>(null);
	const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
	const [submenuStyle, setSubmenuStyle] = useState<React.CSSProperties>({});

	useEffect(() => {
		let cancelled = false;
		const load = () => {
			void window.loom.getChatSettings().then((view) => {
				if (cancelled) return;
				setModels(view.models.filter((row) => row.enabled && row.available).map((row) => ({
					provider: row.provider, modelId: row.id,
					label: `${row.name} (${row.provider})`, thinkingLevels: row.thinkingLevels,
				})));
				setSubmenu(null);
			}).catch(() => { if (!cancelled) { setModels([]); setSubmenu(null); } });
		};
		load();
		const stop = window.loom.onChatSettingsChanged(load);
		return () => { cancelled = true; stop(); };
	}, []);

	function close(restoreFocus = false): void {
		setOpen(false);
		setSubmenu(null);
		if (restoreFocus) buttonRef.current?.focus();
	}

	useEffect(() => { close(); }, [disabled]);

	useLayoutEffect(() => {
		if (!open) return;
		const place = () => {
			const anchor = buttonRef.current;
			const menu = menuRef.current;
			if (!anchor || !menu) return;
			setMenuStyle(composerMenuPosition(anchor, menu));
		};
		place();
		const selected = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
			?? menuRef.current?.querySelector<HTMLButtonElement>('button');
		selected?.focus({ preventScroll: true });
		selected?.scrollIntoView({ block: "nearest" });
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);

	useLayoutEffect(() => {
		if (!submenu || !open) return;
		const place = () => {
			const menu = submenuRef.current;
			if (!menu) return;
			const row = submenu.anchor.getBoundingClientRect();
			const parent = menuRef.current!.getBoundingClientRect();
			if (row.bottom <= parent.top || row.top >= parent.bottom) { setSubmenu(null); return; }
			const right = parent.right + 4;
			const left = right + menu.offsetWidth <= window.innerWidth - 8 ? right : parent.left - menu.offsetWidth - 4;
			setSubmenuStyle({
				left: Math.max(8, left),
				top: Math.max(8, Math.min(row.top - 4, window.innerHeight - menu.offsetHeight - 8)),
			});
		};
		place();
		if (submenu.focus) {
			const selected = submenuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
				?? submenuRef.current?.querySelector<HTMLButtonElement>('button');
			selected?.focus({ preventScroll: true });
		}
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open, submenu]);

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			const target = event.target as Node;
			if (rootRef.current?.contains(target) || menuRef.current?.contains(target) || submenuRef.current?.contains(target)) return;
			close();
		};
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); close(true); }
			if (event.key === "Tab") close();
		};
		window.addEventListener("pointerdown", onPointer);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onPointer);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	if (!models) return null;
	const isCurrent = (row: ModelChoice) => row.provider === model?.provider && row.modelId === model?.modelId;
	const current = models.find(isCurrent);
	const label = current?.label ?? (model ? `${model.provider} / ${model.modelId}` : t.chat.chooseModel);
	const thinkingFor = (row: ModelChoice): ChatThinkingLevel => row.thinkingLevels.find((level) => level === model?.thinkingLevel) ?? row.thinkingLevels[0] ?? "off";

	async function choose(next: ModelChoice, thinkingLevel = thinkingFor(next)): Promise<void> {
		if (disabled) return;
		close(true);
		setError(null);
		try {
			await onChange({ provider: next.provider, modelId: next.modelId, thinkingLevel });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	function openThinking(row: ModelChoice, anchor: HTMLButtonElement, focus = false): void {
		setSubmenu(row.thinkingLevels.length > 1 ? { model: row, anchor, focus } : null);
	}

	return (
		<div className="session-model-select" ref={rootRef}>
			{error && <span className="session-model-error" role="alert">{t.chat.modelChangeFailed}</span>}
			<button ref={buttonRef} type="button" aria-label={t.chat.modelSelect} aria-haspopup="menu"
				aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled} data-tooltip={label}
				onClick={() => { if (open) close(); else setOpen(true); }}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
				}}
			>
				<span className="session-model-label">{label}</span>
				<MenuChevron />
			</button>
			{open && createPortal(<>
				<div ref={menuRef} id={menuId} className="session-permission-menu session-model-menu" role="menu"
					aria-label={t.chat.modelSelect} style={menuStyle} onKeyDown={navigateMenu}
				>
					{models.map((row) => {
						const adjustable = row.thinkingLevels.length > 1;
						const expanded = submenu?.model === row;
						return <button key={`${row.provider}:${row.modelId}`} type="button" role="menuitemradio"
							aria-label={row.label} aria-checked={isCurrent(row)} tabIndex={-1}
							aria-haspopup={adjustable ? "menu" : undefined} aria-expanded={adjustable ? expanded : undefined}
							aria-controls={expanded ? `${menuId}-thinking` : undefined}
							onPointerEnter={(event) => openThinking(row, event.currentTarget)}
							onFocus={() => setSubmenu(null)}
							onClick={(event) => {
								if (adjustable && (event.target as Element).closest(".session-model-effort")) openThinking(row, event.currentTarget, true);
								else void choose(row);
							}}
							onKeyDown={(event) => {
								if (event.key === "ArrowRight" && adjustable) {
									event.preventDefault(); openThinking(row, event.currentTarget, true);
								}
							}}
						>
							<MenuCheck selected={isCurrent(row)} />
							<span className="session-model-label">{row.label}</span>
							{adjustable && <span className="session-model-effort" aria-hidden="true">
								{isCurrent(row) && t.chat.thinkingLevels[thinkingFor(row)]}<MenuChevron right />
							</span>}
						</button>;
					})}
					{models.length === 0 && <span className="session-model-empty">{t.chat.noEnabledModels}</span>}
				</div>
				{submenu && <div ref={submenuRef} id={`${menuId}-thinking`} className="session-permission-menu session-thinking-menu"
					role="menu" aria-label={t.chat.thinkingSelect} style={submenuStyle}
					onKeyDown={(event) => {
						if (event.key === "ArrowLeft" || event.key === "Escape") {
							event.preventDefault(); event.stopPropagation();
							submenu.anchor.focus(); setSubmenu(null);
						} else navigateMenu(event);
					}}
				>
					<div className="session-thinking-heading">{t.chat.thinkingSelect}</div>
					{submenu.model.thinkingLevels.map((level) => <button key={level} type="button" role="menuitemradio"
						tabIndex={-1}
						aria-checked={isCurrent(submenu.model) && (model?.thinkingLevel ?? "off") === level}
						onClick={() => { void choose(submenu.model, level); }}
					>
						<MenuCheck selected={isCurrent(submenu.model) && (model?.thinkingLevel ?? "off") === level} />
						<span>{t.chat.thinkingLevels[level]}</span>
					</button>)}
				</div>}
			</>, document.body)}
		</div>
	);
}

/** Persist bottom-composer choices; fill an unset model when settings/auth become available. */
export function SessionModelSelect({ sessionId, model, onChange, disabled }: {
	sessionId: string;
	model: LoomSessionModel | undefined;
	onChange: () => void;
	disabled: boolean;
}): React.JSX.Element {
	const changed = useRef(onChange);
	changed.current = onChange;
	useEffect(() => {
		if (model || disabled) return;
		let active = true;
		const fill = () => {
			void window.loom.openSession(sessionId).then((record) => {
				if (active && record.model) changed.current();
			}).catch(() => {});
		};
		fill();
		const stop = window.loom.onChatSettingsChanged(fill);
		return () => { active = false; stop(); };
	}, [sessionId, model, disabled]);
	return <ChatModelSelect key={sessionId} model={model} disabled={disabled} onChange={async (selection) => {
		await window.loom.setSessionModel(sessionId, selection);
		onChange();
	}} />;
}

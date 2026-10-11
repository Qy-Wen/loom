import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
	AGENT_PERMISSION_OPTIONS,
	DEFAULT_AGENT_PERMISSION,
	type AgentPermissionLevel,
} from "@loom/agent/tool-permission";
import { useLocale } from "../locale.tsx";

const AgentPermissionContext = createContext<{
	level: AgentPermissionLevel;
	setLevel: (level: AgentPermissionLevel) => void;
}>({
	level: DEFAULT_AGENT_PERMISSION,
	setLevel: () => undefined,
});

export function AgentPermissionProvider({ children }: { children: ReactNode }): React.JSX.Element {
	const [level, setLevelState] = useState<AgentPermissionLevel>(DEFAULT_AGENT_PERMISSION);

	useEffect(() => {
		void window.loom.getAgentPermission().then(setLevelState);
	}, []);

	return (
		<AgentPermissionContext.Provider
			value={{
				level,
				setLevel: (next) => {
					setLevelState(next);
					void window.loom.setAgentPermission(next).then(setLevelState);
				},
			}}
		>
			{children}
		</AgentPermissionContext.Provider>
	);
}

export function useAgentPermission(): {
	level: AgentPermissionLevel;
	setLevel: (level: AgentPermissionLevel) => void;
} {
	return useContext(AgentPermissionContext);
}

export function AgentPermissionSelect(): React.JSX.Element {
	const { level, setLevel } = useAgentPermission();
	const { t } = useLocale();
	const rootRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
	const labels = { basic: t.permission.basic, standard: t.permission.standard, full: t.permission.full };

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

	function choose(next: AgentPermissionLevel): void {
		if (next === level) {
			setOpen(false);
			return;
		}
		if (next === "full" && !window.confirm(t.permission.fullConfirm)) return;
		setLevel(next);
		setOpen(false);
	}

	return (
		<div className="session-permission" ref={rootRef}>
			<button
				ref={buttonRef}
				type="button"
				aria-label={t.permission.label}
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => {
					if (open) {
						setOpen(false);
						return;
					}
					const rect = buttonRef.current?.getBoundingClientRect();
					if (rect) setMenuStyle({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
					setOpen(true);
				}}
			>
				<span>{labels[level]}</span>
				<Chevron />
			</button>
			{open && createPortal(
				<div
					ref={menuRef}
					className="session-permission-menu"
					role="listbox"
					aria-label={t.permission.label}
					style={menuStyle}
				>
					{AGENT_PERMISSION_OPTIONS.map((option) => (
						<button
							key={option.value}
							type="button"
							role="option"
							aria-selected={option.value === level}
							onClick={() => choose(option.value)}
						>
							{labels[option.value]}
						</button>
					))}
				</div>,
				document.body,
			)}
		</div>
	);
}

function Chevron(): React.JSX.Element {
	return (
		<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
			<path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
	AGENT_PERMISSION_OPTIONS,
	DEFAULT_AGENT_PERMISSION,
	type AgentPermissionLevel,
} from "@loom/agent/tool-permission";
import { useLocale } from "../locale.tsx";
import { useConfirmation } from "../components/confirm-dialog.tsx";
import { MenuCheck, MenuChevron } from "./composer-menu-icons.tsx";
import { composerMenuPosition } from "./composer-menu-position.ts";

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
	const { confirm } = useConfirmation();
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
			const anchor = buttonRef.current;
			const menu = menuRef.current;
			if (!anchor || !menu) return;
			setMenuStyle(composerMenuPosition(anchor, menu));
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

	async function choose(next: AgentPermissionLevel): Promise<void> {
		setOpen(false);
		buttonRef.current?.focus();
		if (next === level) return;
		if (next === "full" && !await confirm({
			title: t.permission.fullTitle,
			description: t.permission.fullConfirm,
			confirmLabel: t.permission.fullAction,
			tone: "warning",
		})) return;
		setLevel(next);
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
					setOpen(true);
				}}
			>
				<span>{labels[level]}</span>
				<MenuChevron />
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
							onClick={() => void choose(option.value)}
						>
							<MenuCheck selected={option.value === level} />
							<span>{labels[option.value]}</span>
						</button>
					))}
				</div>,
				document.body,
			)}
		</div>
	);
}

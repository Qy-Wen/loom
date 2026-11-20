import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { Rect } from "../browser/folder-browser-model.ts";

const iconPaths = {
	text: "M3 5V3h10v2M8 3v10m-2 0h4",
	document: "M10 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5Zm0 0v3h3M6 8h4M6 11h4",
	group: "M5 2H2v3m9-3h3v3m0 6v3h-3m-6 0H2v-3m3-6h6v6H5Z",
	pan: "M5 8V4a1 1 0 0 1 2 0v3-5a1 1 0 0 1 2 0v5-4a1 1 0 0 1 2 0v5-2a1 1 0 0 1 2 0v4a4 4 0 0 1-4 4H8a3 3 0 0 1-2.5-1.3L3 9.5A1 1 0 0 1 4.5 8Z",
	minus: "M3 8h10",
	plus: "M3 8h10M8 3v10",
	fit: "M6 2H2v4m8-4h4v4m0 4v4h-4m-4 0H2v-4",
	undo: "M5 3 2 6l3 3M2 6h7a4 4 0 0 1 0 8H7",
	redo: "m11 3 3 3-3 3m3-3H7a4 4 0 0 0 0 8h2",
	connect: "M6 10l4-4M5.5 7.5l-2 2a2.1 2.1 0 0 0 3 3l2-2m-1-5 2-2a2.1 2.1 0 0 1 3 3l-2 2",
	remove: "M2.5 4h11M6 4V2h4v2m2.5 0-.7 10H4.2L3.5 4M6.5 7v4m3-4v4",
	edit: "m3 10-1 4 4-1 7.5-7.5a2.1 2.1 0 0 0-3-3ZM9 4l3 3",
	done: "m3 8 3 3 7-7",
	open: "M9 2h5v5m0-5L7 9m5 0v4H3V4h4",
};

export function CanvasIcon({ name }: { name: keyof typeof iconPaths }): React.JSX.Element {
	return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35"
		strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d={iconPaths[name]} />
	</svg>;
}

export function CanvasAction({ icon, label, showLabel, disabled, pressed, onClick }: {
	icon: keyof typeof iconPaths;
	label: string;
	showLabel?: boolean;
	disabled?: boolean;
	pressed?: boolean;
	onClick: () => void;
}): React.JSX.Element {
	return <button type="button" aria-label={label} aria-disabled={disabled || undefined} aria-pressed={pressed}
		data-tooltip={label} onClick={disabled ? undefined : onClick}>
		<CanvasIcon name={icon} />
		{showLabel && <span>{label}</span>}
	</button>;
}

export function CanvasToolbar({ label, className, children }: {
	label: string;
	className?: string;
	children: ReactNode;
}): React.JSX.Element {
	const toolbar = useRef<HTMLDivElement>(null);
	const current = useRef<HTMLButtonElement | null>(null);
	const needsFallback = !("focusGroup" in HTMLElement.prototype);

	function setTabStop(buttons: HTMLButtonElement[], button: HTMLButtonElement | null): void {
		current.current = button;
		for (const item of buttons) item.tabIndex = item === button ? 0 : -1;
	}

	useLayoutEffect(() => {
		if (!needsFallback || !toolbar.current) return;
		const buttons = [...toolbar.current.querySelectorAll("button")];
		const active = buttons.find((button) => button === current.current) ?? buttons[0] ?? null;
		setTabStop(buttons, active);
	});

	return <div ref={toolbar} className={className ? `canvas-toolbar ${className}` : "canvas-toolbar"}
		role="toolbar" aria-label={label} {...{ focusgroup: "toolbar wrap" }}
		onFocus={needsFallback ? (event) => {
			if (event.target instanceof HTMLButtonElement) {
				setTabStop([...event.currentTarget.querySelectorAll("button")], event.target);
			}
		} : undefined}
		onKeyDown={needsFallback ? (event) => {
			if (!(event.target instanceof HTMLButtonElement) || event.altKey || event.metaKey || event.ctrlKey) return;
			const buttons = [...event.currentTarget.querySelectorAll("button")];
			const index = buttons.indexOf(event.target);
			const forward = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
			const offset = event.key === "ArrowRight" ? forward : event.key === "ArrowLeft" ? -forward : 0;
			const next = offset ? buttons[(index + offset + buttons.length) % buttons.length]
				: event.key === "Home" ? buttons[0] : event.key === "End" ? buttons.at(-1) : undefined;
			if (!next) return;
			event.preventDefault();
			next.focus();
		} : undefined}>
		{children}
	</div>;
}

/** Keep the selection controls at screen size and inside the visible canvas. */
export function CanvasSelectionControls({ anchor, children }: { anchor: Rect; children: ReactNode }): React.JSX.Element {
	const frame = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const panel = frame.current;
		const viewport = panel?.parentElement;
		const docks = viewport?.querySelector<HTMLElement>(".canvas-docks");
		const history = viewport?.querySelector<HTMLElement>(".canvas-history");
		if (!panel || !viewport || !docks || !history) return;
		const position = () => {
			const margin = 8;
			const gap = 8;
			const { clientWidth: width, clientHeight: height } = viewport;
			const right = anchor.x + anchor.width;
			const bottom = anchor.y + anchor.height;
			panel.style.visibility = right < 0 || anchor.x > width || bottom < 0 || anchor.y > height ? "hidden" : "";
			const panelWidth = panel.offsetWidth;
			const panelHeight = panel.offsetHeight;
			const alignedLeft = right - (anchor.width ? panelWidth : panelWidth / 2);
			const left = Math.max(margin, Math.min(alignedLeft, width - margin - panelWidth));
			const bottomLimit = Math.max(margin, docks.offsetTop - gap - panelHeight);
			const topLimit = Math.min(history.offsetTop + history.offsetHeight + gap, bottomLimit);
			const above = anchor.y - gap - panelHeight;
			const top = Math.max(topLimit, Math.min(above >= topLimit ? above : bottom + gap, bottomLimit));
			panel.style.transform = `translate(${left}px, ${top}px)`;
		};
		position();
		const observer = new ResizeObserver(position);
		observer.observe(viewport);
		observer.observe(docks);
		observer.observe(history);
		observer.observe(panel);
		return () => observer.disconnect();
	}, [anchor.x, anchor.y, anchor.width, anchor.height]);

	return <div ref={frame} className="canvas-selection-controls">{children}</div>;
}

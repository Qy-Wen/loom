import type { ReactNode } from "react";
import { useLocale } from "../locale.tsx";
import { usePanelLayout, type PanelId } from "./use-panel-layout.ts";

type Layout = ReturnType<typeof usePanelLayout>;

export function WorkPanel({
	id,
	title,
	layout,
	children,
}: {
	id: PanelId;
	title: string;
	layout: Layout;
	children: ReactNode;
}): React.JSX.Element {
	const place = layout.place(id);
	const grouped = layout.members.includes(id);
	const inactive = grouped && layout.tab !== id;
	return (
		<section
			className={`work-panel ${place.mode}${layout.isSnapping(id) ? " snapping" : ""}${layout.joinTarget === id ? " join-target" : ""}${inactive ? " joined-inactive" : ""}`}
			data-panel={id}
			style={layout.style(id)}
			onPointerDown={() => layout.focus(id)}
		>
			<div
				className="work-panel-title"
				onPointerDown={(event) => layout.beginDrag(id, event)}
			>{title}</div>
			<div className="work-panel-body">{children}</div>
			{place.mode === "float" && !grouped && (
				<>
					<div className="work-panel-edge right" onPointerDown={(event) => layout.beginResize(id, "right", event)} />
					<div className="work-panel-edge bottom" onPointerDown={(event) => layout.beginResize(id, "bottom", event)} />
					<div className="work-panel-edge corner" onPointerDown={(event) => layout.beginResize(id, "corner", event)} />
				</>
			)}
		</section>
	);
}

export function PanelsToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }): React.JSX.Element {
	const { t } = useLocale();
	const label = collapsed ? t.app.expandPanels : t.app.collapsePanels;
	return (
		<button className="panel-collapse" type="button" aria-label={label} onClick={onToggle}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				<rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
				<path d="M10.3 2.8v10.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
			</svg>
		</button>
	);
}

export function PanelTabs({ layout }: { layout: Layout }): React.JSX.Element {
	const { t } = useLocale();
	return (
		<div
			className={`panel-tabs${layout.tabReorder ? " reordering" : ""}`}
			onPointerDown={(event) => {
				if ((event.target as HTMLElement).closest("button")) return;
				layout.beginGroupDrag(event);
			}}
		>
			{layout.tabOrder.map((id) => (
				<button
					key={id}
					type="button"
					data-tab={id}
					className={`${layout.tab === id ? "active" : ""}${layout.tabReorder?.id === id ? " dragging" : ""}`}
					onPointerDown={(event) => layout.beginTabDrag(id, event)}
				>{id === "agent" ? t.app.agent : id === "details" ? t.app.details : t.grade.panel}</button>
			))}
			{layout.tabReorder?.insertX != null && (
				<span className="panel-tab-insert" style={{ left: layout.tabReorder.insertX }} />
			)}
		</div>
	);
}

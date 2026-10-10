import type { ReactNode } from "react";
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
	const inactive = layout.joined && layout.tab !== id;
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
			{place.mode === "float" && !layout.joined && (
				<>
					<div className="work-panel-edge right" onPointerDown={(event) => layout.beginResize(id, "right", event)} />
					<div className="work-panel-edge bottom" onPointerDown={(event) => layout.beginResize(id, "bottom", event)} />
					<div className="work-panel-edge corner" onPointerDown={(event) => layout.beginResize(id, "corner", event)} />
				</>
			)}
		</section>
	);
}

export function PanelTabs({ layout }: { layout: Layout }): React.JSX.Element {
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
				>{id === "agent" ? "Agent" : "Details"}</button>
			))}
			{layout.tabReorder?.insertX != null && (
				<span className="panel-tab-insert" style={{ left: layout.tabReorder.insertX }} />
			)}
		</div>
	);
}

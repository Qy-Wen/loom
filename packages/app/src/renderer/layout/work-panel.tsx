import { Fragment, type ReactNode } from "react";
import { useLocale } from "../locale.tsx";
import type { PanelRegistration, PanelRegion, PanelSlot } from "./panel-layout.ts";
import { PANEL_REGIONS } from "./panel-layout.ts";
import type { usePanelLayout } from "./use-panel-layout.ts";

type Layout = ReturnType<typeof usePanelLayout>;
export interface PanelView extends PanelRegistration {
	title: string;
	render: () => ReactNode;
}

function PanelSlotView({ slot, layout, panels }: { slot: PanelSlot; layout: Layout; panels: readonly PanelView[] }) {
	const byId = new Map(panels.map((panel) => [panel.id, panel]));
	const active = layout.activeTab(slot);
	const joined = slot.tabs.length > 1;
	const target = layout.joinTarget === slot.id;
	const mode = slot.place.mode;
	const regionClass = mode === "float" ? "floating" : `${mode}-band`;
	return (
		<div
			data-slot={slot.id}
			inert={mode === "float" && layout.panelsCollapsed}
			aria-hidden={mode === "float" && layout.panelsCollapsed || undefined}
			className={`panel-slot${joined ? ` side-stack joined ${regionClass}` : ""}${layout.isDragging(slot) ? " group-drag" : ""}${layout.isPreview(slot) ? " drop-preview" : ""}${target ? " join-target" : ""}`}
			style={layout.slotStyle(slot)}
		>
			{joined && <div className={`panel-tabs${layout.tabReorder?.slotId === slot.id ? " reordering" : ""}`} onPointerDown={(event) => {
				if ((event.target as HTMLElement).closest("button")) return;
				layout.beginGroupDrag(slot.id, event);
			}}>
				{layout.visibleTabs(slot).map((id) => <button key={id} type="button" data-tab={id}
					className={`${active === id ? "active" : ""}${layout.tabReorder?.id === id ? " dragging" : ""}`}
					onPointerDown={(event) => layout.beginTabDrag(id, event)}>{byId.get(id)?.title}</button>)}
				{layout.tabReorder?.slotId === slot.id && layout.tabReorder.insertX != null && <span className="panel-tab-insert" style={{ left: layout.tabReorder.insertX }} />}
			</div>}
			{slot.tabs.map((id) => {
				const panel = byId.get(id);
				if (!panel?.visible) return null;
				return <section key={id} data-panel={id}
					className={`work-panel ${mode}${target ? " join-target" : ""}${joined && active !== id ? " joined-inactive" : ""}`}
					onPointerDown={() => layout.focus(id)}>
					<div className="work-panel-title" onPointerDown={(event) => layout.beginDrag(id, event)}>{panel.title}</div>
					<div className="work-panel-body">{panel.render()}</div>
				</section>;
			})}
			{mode === "float" && <>
				<div className="work-panel-edge right" onPointerDown={(event) => layout.beginResize(slot.id, "right", event)} />
				<div className="work-panel-edge bottom" onPointerDown={(event) => layout.beginResize(slot.id, "bottom", event)} />
				<div className="work-panel-edge corner" onPointerDown={(event) => layout.beginResize(slot.id, "corner", event)} />
			</>}
		</div>
	);
}

/** Region containers never depend on panel identity/count or on a single global tab group. */
export function PanelWorkspace({ layout, panels }: { layout: Layout; panels: readonly PanelView[] }): React.JSX.Element {
	const { t } = useLocale();
	const region = (mode: PanelRegion) => {
		const slots = layout.regionSlots(mode);
		if (!slots.length) return null;
		return <div key={mode} data-region={mode} className={`panel-region ${mode}-band`} inert={layout.panelsCollapsed} aria-hidden={layout.panelsCollapsed || undefined}>
			<div className="panel-region-content">
			{slots.map((slot, index) => <Fragment key={slot.id}>
				{index > 0 && <div className="resize-handle row" role="separator" aria-label={t.app.resizeSplit} aria-orientation="horizontal"
					onPointerDown={(event) => layout.beginSlotResize(slots[index - 1], slot, event)} />}
				<PanelSlotView slot={slot} layout={layout} panels={panels} />
			</Fragment>)}
			</div>
		</div>;
	};
	return <>
		{PANEL_REGIONS.map(region)}
		{layout.slots.filter((slot) => slot.place.mode === "float").map((slot) => <PanelSlotView key={slot.id} slot={slot} layout={layout} panels={panels} />)}
	</>;
}

export function PanelsToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }): React.JSX.Element {
	const { t } = useLocale();
	const label = collapsed ? t.app.expandPanels : t.app.collapsePanels;
	return <button className="panel-collapse" type="button" aria-label={label} onClick={onToggle}>
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
			<path d="M10.3 2.8v10.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
		</svg>
	</button>;
}

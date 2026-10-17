import { type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef, useState } from "react";
import { bottomBand, clampFloat, dockSplitEdge, MIN_PANEL_HEIGHT, pointerDocks, pointerInside, pointerNearLowerBand, pointerOnLeftEdge, pointerOnTopEdge, type FloatRect, type PanelPlace } from "./panel-geometry.ts";
import {
	activeTab, extractPanel, focusPanel, movePanel, PANEL_LAYOUT_KEY, readPanelLayout,
	reconcilePanels, relativeRect, reorderTabs, resizeSlots, slotFor, slotWeights, visibleTabs,
	type PanelDrop, type PanelId, type PanelLayoutState, type PanelMove, type PanelRegistration, type PanelRegion, type PanelSlot,
} from "./panel-layout.ts";
export type { PanelId, PanelRegistration } from "./panel-layout.ts";

interface Target {
	drop: PanelDrop;
	frame: FloatRect;
	kind: "join" | "split" | "splice" | "dock" | "lower";
}
interface Drag {
	move: PanelMove;
	rect: FloatRect;
	target: Target | null;
}
interface DropGeometry {
	bounds: DOMRect;
	rows: { slot: PanelSlot; box: DOMRect; joinFrame: FloatRect; layer: number }[];
	regions: Partial<Record<PanelRegion, DOMRect>>;
	bandTops: Partial<Record<"bottom" | "above", number>>;
}

function previewsLayout(target: Target | null): target is Target {
	const drop = target?.drop;
	return !!drop && (drop.kind === "split" || drop.kind === "band" || (drop.kind === "place" && (drop.place.mode === "above" || drop.place.mode === "bottom")));
}
interface TabReorder {
	id: PanelId;
	slotId: string;
	insertX: number | null;
	next: PanelId[] | null;
}

function readHeight(key: string, fallback: number): number {
	const raw = localStorage.getItem(key);
	const value = raw === null ? fallback : Number(raw);
	return Number.isFinite(value) ? Math.max(160, Math.min(640, value)) : fallback;
}
const readCssPx = (shell: HTMLElement, name: string, fallback: number) => {
	const value = Number.parseFloat(getComputedStyle(shell).getPropertyValue(name));
	return Number.isFinite(value) ? value : fallback;
};

/** Registered panels share slot-based drag, tab, sizing and persistence rules in every region. */
export function usePanelLayout(shellRef: RefObject<HTMLDivElement | null>, registrations: readonly PanelRegistration[]) {
	const [state, setState] = useState(() => readPanelLayout(localStorage, registrations));
	const stateRef = useRef(state); stateRef.current = state;
	const registrationsRef = useRef(registrations); registrationsRef.current = registrations;
	const [panelsCollapsed, setPanelsCollapsed] = useState(() => localStorage.getItem("loom.layout.panelsCollapsed") === "1");
	const [bottomHeight, setBottomHeight] = useState(() => readHeight("loom.layout.bottomHeight", 340));
	const [aboveHeight, setAboveHeight] = useState(() => readHeight("loom.layout.aboveHeight", 220));
	const [drag, setDrag] = useState<Drag | null>(null);
	const [tabReorder, setTabReorder] = useState<TabReorder | null>(null);
	const [layers, setLayers] = useState<Record<string, number>>({});
	const cleanupRef = useRef<(() => void) | null>(null);
	const ids = registrations.map((panel) => panel.id).join("\0");
	useEffect(() => { update(reconcilePanels(stateRef.current, registrationsRef.current)); }, [ids]);
	const shownIds = registrations.filter((panel) => panel.visible).map((panel) => panel.id).join("\0");
	useEffect(() => {
		let next = stateRef.current;
		for (const panel of registrationsRef.current) if (panel.visible && !next.opened.includes(panel.id)) next = focusPanel(next, panel.id, registrationsRef.current);
		if (next !== stateRef.current) update(next);
	}, [shownIds]);
	useEffect(() => { localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(state)); }, [state]);
	useEffect(() => { localStorage.setItem("loom.layout.bottomHeight", String(bottomHeight)); }, [bottomHeight]);
	useEffect(() => { localStorage.setItem("loom.layout.aboveHeight", String(aboveHeight)); }, [aboveHeight]);
	useEffect(() => () => cleanupRef.current?.(), []);

	function update(next: PanelLayoutState) { stateRef.current = next; setState(next); }
	function focus(id: PanelId) {
		const next = focusPanel(stateRef.current, id, registrationsRef.current);
		update(next);
		const slot = slotFor(next, id);
		if (slot) setLayers((current) => ({ ...current, [slot.id]: Math.max(0, ...Object.values(current)) + 1 }));
	}
	const extracted = drag && extractPanel(state, drag.move);
	const preview = drag && previewsLayout(drag.target) ? drag.target : null;
	const effective = preview ? movePanel(state, drag!.move, preview.drop)
		: extracted ? { ...extracted.state, slots: [...extracted.state.slots, { ...extracted.slot, place: { mode: "float", ...drag!.rect } as PanelPlace }] } : state;
	const slots = effective.slots.filter((slot) => visibleTabs(slot, registrations).length > 0);
	const regionSlots = (region: PanelRegion) => slots.filter((slot) => slot.place.mode === region);
	const hasRegion = (region: PanelRegion) => regionSlots(region).length > 0;
	const place = (id: PanelId): PanelPlace => slotFor(effective, id)?.place ?? { mode: "dock" };

	function slotStyle(slot: PanelSlot): CSSProperties {
		if (slot.place.mode === "float") {
			const { x, y, width, height } = slot.place;
			return { left: x, top: y, width, height, zIndex: drag && slot.id === extracted?.slot.id ? 40 : 8 + (layers[slot.id] ?? 0) };
		}
		return { flexGrow: slotWeights(regionSlots(slot.place.mode)).get(slot.id) ?? 1, flexBasis: 0 };
	}

	// Keep all slot rectangles in shell coordinates when the window changes size.
	useEffect(() => {
		const shell = shellRef.current;
		if (!shell) return;
		const observer = new ResizeObserver(() => {
			const bounds = shell.getBoundingClientRect();
			const current = stateRef.current;
			let changed = false;
			const next = current.slots.map((slot) => {
				if (slot.place.mode !== "float") return slot;
				const rect = clampFloat(slot.place, bounds);
				if (rect.x === slot.place.x && rect.y === slot.place.y && rect.width === slot.place.width && rect.height === slot.place.height) return slot;
				changed = true;
				return { ...slot, place: { mode: "float", ...rect } as PanelPlace };
			});
			if (changed) update({ ...current, slots: next });
		});
		observer.observe(shell);
		return () => observer.disconnect();
	});

	function startPointer(onMove: (event: PointerEvent) => void, onUp: (event: PointerEvent) => void, className: string, handle?: HTMLElement) {
		cleanupRef.current?.();
		handle?.classList.add("dragging");
		const stop = () => {
			handle?.classList.remove("dragging");
			document.body.classList.remove(className);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", cancel);
			cleanupRef.current = null;
		};
		const end = (event: PointerEvent) => { stop(); onUp(event); };
		const cancel = () => { stop(); setDrag(null); setTabReorder(null); };
		cleanupRef.current = cancel;
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", cancel);
	}

	function measureDropGeometry(move: PanelMove, bounds: DOMRect): DropGeometry | null {
		const current = extractPanel(stateRef.current, move);
		const shell = shellRef.current;
		if (!current || !shell) return null;
		const remaining = current.state.slots.filter((slot) => visibleTabs(slot, registrationsRef.current).length);
		const rows = remaining.flatMap((slot) => {
			const element = [...shell.querySelectorAll<HTMLElement>("[data-slot]")].find((element) => element.dataset.slot === slot.id);
			if (!element) return [];
			const box = element.getBoundingClientRect();
			const title = element.querySelector<HTMLElement>(":scope > .panel-tabs, :scope > .work-panel > .work-panel-title");
			const top = (slot.place.mode === "bottom" || slot.place.mode === "above") && title ? title.getBoundingClientRect().top - readCssPx(shell, "--join-border-width", 2) : box.top;
			return [{ slot, box, layer: Number.parseFloat(getComputedStyle(element).zIndex) || 0,
				joinFrame: { x: box.left - bounds.left, y: top - bounds.top, width: box.width, height: box.bottom - top } }];
		}).filter(({ box }) => box.width > 1 && box.height > 1);
		const regions: DropGeometry["regions"] = {};
		for (const mode of ["dock", "beside", "above", "bottom"] as const) {
			const box = shell.querySelector<HTMLElement>(`.panel-region[data-region="${mode}"]`)?.getBoundingClientRect();
			if (box) regions[mode] = box;
		}
		const bandTops: DropGeometry["bandTops"] = {};
		for (const mode of ["bottom", "above"] as const) {
			const divider = shell.querySelector(`.${mode}-resize`);
			const top = divider && Number.parseFloat(getComputedStyle(divider, "::after").top);
			if (divider && typeof top === "number" && Number.isFinite(top)) bandTops[mode] = divider.getBoundingClientRect().top + top;
		}
		return { bounds, rows, regions, bandTops };
	}

	function targetAt(geometry: DropGeometry | null, x: number, y: number): Target | null {
		const shell = shellRef.current;
		if (!geometry || !shell) return null;
		const { bounds, rows } = geometry;
		const remaining = rows.map(({ slot }) => slot);
		const regionBox = (mode: PanelRegion) => geometry.regions[mode];
		const strokeTop = (mode: "bottom" | "above", fallback: number) => geometry.bandTops[mode] ?? fallback;
		// Later DOM siblings win equal z-index, matching what the user can see.
		const under = [...rows].reverse().filter(({ box }) => pointerInside(x, y, box)).sort((a, b) => b.layer - a.layer)[0];
		if (under) {
			const { slot, box, joinFrame } = under;
			const edge = dockSplitEdge(x, y, box);
			// Preserve the two central bands: inserting above a bottom panel creates
			// the upper band, inserting below moves its whole band above the new one.
			if (slot.place.mode === "bottom" && edge && remaining.filter((slot) => slot.place.mode === "bottom").length === 1) {
				const bottom = regionBox("bottom") ?? box;
				const above = regionBox("above");
				if (edge === "top") {
					const frame = above ? relativeRect(above, bounds) : { x: bottom.left - bounds.left, y: bottom.top - bounds.top - aboveHeight, width: bottom.width, height: aboveHeight };
					frame.height = strokeTop("bottom", bottom.top) - bounds.top - frame.y;
					return { kind: "splice", frame, drop: { kind: "place", place: { mode: "above" } } };
				}
				const top = strokeTop("bottom", bottom.top);
				return { kind: "splice", frame: { x: bottom.left - bounds.left, y: top - bounds.top, width: bottom.width, height: bottom.bottom - top }, drop: { kind: "band", place: { mode: "bottom" }, promote: remaining.filter((slot) => slot.place.mode === "bottom").map((slot) => slot.id), promotedPlace: { mode: "above" } } };
			}
			if (edge && (slot.place.mode !== "float" || box.height >= MIN_PANEL_HEIGHT * 2)) {
				return { kind: "split", drop: { kind: "split", target: slot.id, edge }, frame: { x: box.left - bounds.left, y: box.top - bounds.top + (edge === "bottom" ? box.height / 2 : 0), width: box.width, height: box.height / 2 } };
			}
			if (slot.place.mode === "dock" && pointerOnLeftEdge(x, y, box)) {
				const dock = regionBox("dock") ?? box;
				const beside = regionBox("beside");
				const bottom = regionBox("bottom");
				const width = readCssPx(shell, "--beside-width", 300);
				return { kind: "splice", drop: { kind: "place", place: { mode: "beside" } }, frame: beside ? relativeRect(beside, bounds) : { x: dock.left - bounds.left - width, y: dock.top - bounds.top, width, height: bottom ? bottom.top - dock.top : dock.height } };
			}
			return { kind: "join", drop: { kind: "join", target: slot.id }, frame: joinFrame };
		}
		// A little slack above the bottom band / left of the dock is still a splice target.
		const bottom = regionBox("bottom");
		if (bottom && pointerOnTopEdge(x, y, bottom)) {
			const above = regionBox("above");
			const frame = above ? relativeRect(above, bounds) : { x: bottom.left - bounds.left, y: bottom.top - bounds.top - aboveHeight, width: bottom.width, height: aboveHeight };
			frame.height = strokeTop("bottom", bottom.top) - bounds.top - frame.y;
			return { kind: "splice", frame, drop: { kind: "place", place: { mode: "above" } } };
		}
		const dock = regionBox("dock");
		if (dock && pointerOnLeftEdge(x, y, dock)) {
			const beside = regionBox("beside");
			const width = readCssPx(shell, "--beside-width", 300);
			return { kind: "splice", drop: { kind: "place", place: { mode: "beside" } }, frame: beside ? relativeRect(beside, bounds) : { x: dock.left - bounds.left - width, y: dock.top - bounds.top, width, height: bottom ? bottom.top - dock.top : dock.height } };
		}
		if (pointerDocks(x, bounds.right)) return { kind: "dock", drop: { kind: "place", place: { mode: "dock" } }, frame: { x: bounds.width - readCssPx(shell, "--side-width", 380) - 5, y: 0, width: readCssPx(shell, "--side-width", 380) + 5, height: bounds.height } };
		const side = remaining.some((slot) => slot.place.mode === "dock") ? readCssPx(shell, "--side-width", 380) : 0;
		const band = bottomBand(bounds, readCssPx(shell, "--library-width", 240), side, bottomHeight);
		return pointerNearLowerBand(x - bounds.left, y - bounds.top, band) ? { kind: "lower", frame: band, drop: { kind: "place", place: { mode: "bottom" } } } : null;
	}

	function beginDrag(move: PanelMove, event: ReactPointerEvent<HTMLElement> | PointerEvent, source?: HTMLElement, immediate = false) {
		if (!immediate && event.button !== 0) return;
		const shell = shellRef.current;
		const element = source ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
		const originElement = element?.closest<HTMLElement>("[data-slot]");
		if (!shell || !originElement) return;
		event.preventDefault(); event.stopPropagation();
		if (move.kind === "panel") focus(move.id);
		const origin = originElement.getBoundingClientRect();
		const bounds = shell.getBoundingClientRect();
		let rect = relativeRect(origin, bounds);
		const grabX = event.clientX - origin.left;
		let grabY = event.clientY - origin.top;
		const startX = event.clientX, startY = event.clientY;
		let moved = false;
		let target: Target | null = null;
		let geometry: DropGeometry | null = null;
		const onMove = (pointer: PointerEvent) => {
			const box = shell.getBoundingClientRect();
			const starting = !moved;
			if (!moved) {
				if (!immediate && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 4) return;
				moved = true;
				document.body.classList.add("dragging-panel");
				if (rect.height > box.height * 0.62) { rect.height = Math.max(MIN_PANEL_HEIGHT, Math.round(box.height * 0.55)); grabY = Math.min(grabY, rect.height - 24); }
			}
			rect = clampFloat({ ...rect, x: pointer.clientX - box.left - grabX, y: pointer.clientY - box.top - grabY }, box);
			// Hit-test the layout before previewing it, so a shrinking target cannot
			// change its own drop zones. Refresh after returning to a floating drag.
			if (!previewsLayout(target)) geometry = measureDropGeometry(move, box);
			target = starting ? null : targetAt(geometry, pointer.clientX, pointer.clientY);
			setDrag({ move, rect, target });
		};
		startPointer(onMove, (pointer) => {
			setDrag(null);
			if (!moved) {
				if (move.kind === "panel") focus(move.id);
				if (pointer.detail >= 2) update(movePanel(stateRef.current, move, { kind: "place", place: { mode: "dock" } }));
				return;
			}
			const settled = targetAt(previewsLayout(target) ? geometry : measureDropGeometry(move, shell.getBoundingClientRect()), pointer.clientX, pointer.clientY);
			update(movePanel(stateRef.current, move, settled?.drop ?? { kind: "place", place: { mode: "float", ...rect } }));
		}, "dragging-panel");
		if (immediate) onMove(event as PointerEvent);
	}

	function beginTabDrag(id: PanelId, event: ReactPointerEvent<HTMLElement>) {
		if (event.button !== 0) return;
		const bar = event.currentTarget.closest<HTMLElement>(".panel-tabs");
		const slot = slotFor(stateRef.current, id);
		if (!bar || !slot) return;
		event.preventDefault(); event.stopPropagation(); focus(id);
		const source = event.currentTarget;
		const x = event.clientX, y = event.clientY;
		let reorder: TabReorder | null = null;
		startPointer((pointer) => {
			if (Math.hypot(pointer.clientX - x, pointer.clientY - y) < 4) return;
			const box = bar.getBoundingClientRect();
			if (pointer.clientX < box.left - 12 || pointer.clientX > box.right + 12 || pointer.clientY < box.top - 8 || pointer.clientY > box.bottom + 8) {
				setTabReorder(null);
				beginDrag({ kind: "panel", id }, pointer, source, true);
				return;
			}
			const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button[data-tab]")];
			const tabs = buttons.map((button) => button.dataset.tab!);
			const placed = placeTab(tabs, id, pointer.clientX, buttons.map((button) => button.getBoundingClientRect()));
			const changed = tabs.join() !== placed.join();
			const at = placed.indexOf(id);
			const neighbor = at === 0 ? placed[1] : placed[at - 1];
			const neighborBox = buttons[tabs.indexOf(neighbor)]?.getBoundingClientRect();
			reorder = { id, slotId: slot.id, next: changed ? placed : null, insertX: changed && neighborBox ? (at === 0 ? neighborBox.left : neighborBox.right) - box.left : null };
			setTabReorder(reorder);
		}, () => {
			setTabReorder(null);
			if (reorder?.next) update({ ...stateRef.current, slots: stateRef.current.slots.map((row) => row.id === slot.id ? reorderTabs(row, visibleTabs(row, registrationsRef.current), reorder!.next!) : row) });
		}, "dragging-panel");
	}

	function beginResize(slotId: string, edge: "right" | "bottom" | "corner", event: ReactPointerEvent<HTMLElement>) {
		const slot = stateRef.current.slots.find((row) => row.id === slotId);
		const shell = shellRef.current;
		if (event.button !== 0 || !slot || slot.place.mode !== "float" || !shell) return;
		event.preventDefault(); event.stopPropagation();
		const origin = slot.place;
		const x = event.clientX, y = event.clientY;
		document.body.classList.add("resizing-panel");
		startPointer((pointer) => {
			const rect = clampFloat({ ...origin, width: origin.width + (edge === "bottom" ? 0 : pointer.clientX - x), height: origin.height + (edge === "right" ? 0 : pointer.clientY - y) }, shell.getBoundingClientRect());
			update({ ...stateRef.current, slots: stateRef.current.slots.map((row) => row.id === slotId ? { ...row, place: { mode: "float", ...rect } } : row) });
		}, () => {}, "resizing-panel");
	}

	function beginSlotResize(upper: PanelSlot, lower: PanelSlot, event: ReactPointerEvent<HTMLElement>) {
		if (event.button !== 0) return;
		const shell = shellRef.current;
		const box = (slot: PanelSlot) => [...shell?.querySelectorAll<HTMLElement>("[data-slot]") ?? []].find((element) => element.dataset.slot === slot.id)?.getBoundingClientRect();
		const a = box(upper), b = box(lower);
		if (!a || !b) return;
		event.preventDefault(); document.body.classList.add("resizing-rows");
		const original = stateRef.current;
		startPointer((pointer) => update(resizeSlots(original, upper.id, lower.id, (pointer.clientY - a.top) / (b.bottom - a.top))), () => {}, "resizing-rows", event.currentTarget);
	}

	function beginBandResize(mode: "bottom" | "above", event: ReactPointerEvent<HTMLElement>) {
		const shell = shellRef.current;
		if (event.button !== 0 || !shell) return;
		event.preventDefault(); document.body.classList.add("resizing-rows");
		const bounds = shell.getBoundingClientRect();
		const y = event.clientY, height = aboveHeight;
		startPointer((pointer) => {
			const value = mode === "bottom" ? bounds.bottom - pointer.clientY : height + y - pointer.clientY;
			(mode === "bottom" ? setBottomHeight : setAboveHeight)(Math.min(bounds.height - 180, Math.max(160, value)));
		}, () => {}, "resizing-rows", event.currentTarget);
	}

	return {
		state, slots, regionSlots, hasRegion, place, slotStyle, focus,
		activeTab: (slot: PanelSlot) => activeTab(slot, registrations),
		visibleTabs: (slot: PanelSlot) => visibleTabs(slot, registrations),
		isDragging: (slot: PanelSlot) => !!drag && slot.id === extracted?.slot.id,
		isPreview: (slot: PanelSlot) => !!preview && slot.id === extracted?.slot.id,
		beginDrag: (id: PanelId, event: ReactPointerEvent<HTMLElement>) => beginDrag({ kind: "panel", id }, event),
		beginGroupDrag: (slotId: string, event: ReactPointerEvent<HTMLElement>) => beginDrag({ kind: "slot", id: slotId }, event),
		beginTabDrag, beginResize, beginSlotResize,
		beginBottomResize: (event: ReactPointerEvent<HTMLElement>) => beginBandResize("bottom", event),
		beginAboveResize: (event: ReactPointerEvent<HTMLElement>) => beginBandResize("above", event),
		bottomHeight, aboveHeight, tabReorder, panelsCollapsed,
		togglePanelsCollapsed: () => setPanelsCollapsed((current) => { localStorage.setItem("loom.layout.panelsCollapsed", current ? "0" : "1"); return !current; }),
		dragDock: drag?.target?.kind === "dock",
		lowerFrame: drag?.target?.kind === "lower" ? drag.target.frame : null,
		joinFrame: drag?.target?.kind === "join" ? drag.target.frame : null,
		joinTarget: drag?.target?.drop.kind === "join" ? drag.target.drop.target : null,
		spliceFrame: drag?.target?.kind === "splice" ? drag.target.frame : null,
		dockSplitFrame: drag?.target?.kind === "split" ? drag.target.frame : null,
	};
}

/** Horizontal tab order uses the same operation for every slot. */
export function placeTab(order: readonly string[], id: string, clientX: number, boxes: readonly { left: number; right: number }[]): string[] {
	if (!order.includes(id) || boxes.length !== order.length) return [...order];
	const rest = order.filter((item) => item !== id);
	const at = rest.findIndex((item) => { const box = boxes[order.indexOf(item)]; return clientX < (box.left + box.right) / 2; });
	const index = at < 0 ? rest.length : at;
	return [...rest.slice(0, index), id, ...rest.slice(index)];
}

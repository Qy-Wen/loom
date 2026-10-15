import type { FloatRect, PanelPlace } from "./panel-geometry.ts";

export type PanelId = string;
export type PanelRegion = Exclude<PanelPlace["mode"], "float">;
export const PANEL_REGIONS: readonly PanelRegion[] = ["dock", "beside", "above", "bottom"];
export const PANEL_LAYOUT_KEY = "loom.layout.panels";

export interface PanelRegistration {
	id: PanelId;
	visible: boolean;
	initialPlace?: PanelPlace;
	/** On a fresh layout, append this panel to the first listed panel in the same region. */
	initialJoin?: readonly PanelId[];
	/** Applied once, when first shown. Saved user placement always wins. */
	firstOpen?: { place: PanelPlace; join?: readonly PanelId[] };
}

export interface PanelSlot {
	/** Stable container identity, independent of tab selection/order. */
	id: string;
	tabs: PanelId[];
	active: PanelId;
	place: PanelPlace;
	weight: number;
}

export interface PanelLayoutState {
	version: 1;
	slots: PanelSlot[];
	opened: PanelId[];
}

const unique = <T>(items: readonly T[]) => [...new Set(items)];
const positive = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

function parsePlace(value: unknown): PanelPlace | undefined {
	if (!value || typeof value !== "object") return undefined;
	const row = value as Record<string, unknown>;
	if (PANEL_REGIONS.includes(row.mode as PanelRegion)) return { mode: row.mode as PanelRegion };
	if (row.mode === "float" && [row.x, row.y, row.width, row.height].every((n) => typeof n === "number" && Number.isFinite(n)) && Number(row.width) > 0 && Number(row.height) > 0) {
		return { mode: "float", x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height) };
	}
	return undefined;
}

export function slotFor(state: PanelLayoutState, id: PanelId): PanelSlot | undefined {
	return state.slots.find((slot) => slot.tabs.includes(id));
}

export function visibleTabs(slot: PanelSlot, registrations: readonly PanelRegistration[]): PanelId[] {
	const visible = new Set(registrations.filter((panel) => panel.visible).map((panel) => panel.id));
	return slot.tabs.filter((id) => visible.has(id));
}

export function activeTab(slot: PanelSlot, registrations: readonly PanelRegistration[]): PanelId | undefined {
	const tabs = visibleTabs(slot, registrations);
	return tabs.includes(slot.active) ? slot.active : tabs[0];
}

/** Reconcile any number of registered panels; unknown/stale IDs never become ghost slots. */
export function reconcilePanels(state: PanelLayoutState, registrations: readonly PanelRegistration[]): PanelLayoutState {
	const known = new Set(registrations.map((panel) => panel.id));
	if (known.size !== registrations.length) throw new Error("Duplicate panel registration");
	const used = new Set<string>();
	const slotIds = new Set<string>();
	const slots: PanelSlot[] = [];
	for (const slot of state.slots) {
		const tabs = unique(slot.tabs).filter((id) => known.has(id) && !used.has(id));
		if (!tabs.length) continue;
		for (const id of tabs) used.add(id);
		let id = slot.id;
		while (slotIds.has(id)) id += ":slot";
		slotIds.add(id);
		slots.push({ ...slot, id, tabs, active: tabs.includes(slot.active) ? slot.active : tabs[0], weight: positive(slot.weight, 1) });
	}
	for (const panel of registrations) if (!used.has(panel.id)) {
		let id = panel.id;
		while (slotIds.has(id)) id += ":slot";
		slotIds.add(id);
		slots.push({ id, tabs: [panel.id], active: panel.id, place: panel.initialPlace ?? { mode: "dock" }, weight: 1 });
	}
	return { version: 1, slots, opened: unique(state.opened).filter((id) => known.has(id)) };
}

/** Read the new slot document, or import old per-panel placement once. No legacy writes. */
export function readPanelLayout(storage: Pick<Storage, "getItem">, registrations: readonly PanelRegistration[]): PanelLayoutState {
	try {
		const raw = JSON.parse(storage.getItem(PANEL_LAYOUT_KEY) ?? "null");
		if (raw?.version === 1 && Array.isArray(raw.slots) && Array.isArray(raw.opened)) {
			const slots: PanelSlot[] = raw.slots.flatMap((row: Record<string, unknown>) => {
				const place = parsePlace(row?.place);
				return row && typeof row.id === "string" && Array.isArray(row.tabs) && row.tabs.every((id) => typeof id === "string") && place
					? [{ id: row.id, tabs: row.tabs as string[], active: typeof row.active === "string" ? row.active : row.tabs[0] as string, place, weight: positive(row.weight, 1) }]
					: [];
			});
			return reconcilePanels({ version: 1, slots, opened: raw.opened.filter((id: unknown) => typeof id === "string") }, registrations);
		}
	} catch { /* Invalid layout falls back to registered defaults and legacy placement. */ }
	const stored = <T>(key: string, fallback: T): T => {
		try { return JSON.parse(storage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
	};
	const order = unique([...(storage.getItem("loom.layout.dockOrder") ?? "").split(","), ...registrations.map((panel) => panel.id)]);
	const weights = stored<Record<string, number>>("loom.layout.dockWeights", {});
	const split = positive(stored<number>("loom.layout.dockSplit", 0.5), 0.5);
	const opened: string[] = [];
	const savedPlacement = Boolean(storage.getItem("loom.layout.dockOrder") || storage.getItem("loom.layout.members") || storage.getItem("loom.layout.joined") || storage.getItem("loom.layout.dockWeights") || storage.getItem("loom.layout.dockSplit") || registrations.some((panel) => storage.getItem(`loom.layout.${panel.id}Place`)));
	let slots = registrations.map((panel): PanelSlot => {
		const place = parsePlace(stored(`loom.layout.${panel.id}Place`, null));
		if (place || !panel.firstOpen) opened.push(panel.id);
		return { id: panel.id, tabs: [panel.id], active: panel.id, place: place ?? panel.initialPlace ?? { mode: "dock" }, weight: positive(weights?.[panel.id], panel.id === "agent" ? split : panel.id === "details" ? Math.max(0.01, 1 - split) : 1) };
	}).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
	if (!savedPlacement) for (const panel of registrations) {
		if (!panel.initialJoin?.length) continue;
		const source = slots.find((slot) => slot.tabs.length === 1 && slot.id === panel.id);
		if (!source) continue;
		const target = panel.initialJoin.map((id) => slots.find((slot) => slot.tabs.includes(id) && slot !== source && slot.place.mode === source.place.mode)).find((slot) => slot !== undefined);
		if (!target) continue;
		const group = { ...target, tabs: [...target.tabs, panel.id], weight: target.weight + source.weight };
		slots = slots.flatMap((slot) => slot === target ? [group] : slot === source ? [] : [slot]);
		opened.push(panel.id);
	}
	const legacyMembers = storage.getItem("loom.layout.members") ?? (storage.getItem("loom.layout.joined") === "1" ? storage.getItem("loom.layout.tabOrder") ?? "agent,details" : "");
	const members = unique(legacyMembers.split(",")).filter((id) => registrations.some((panel) => panel.id === id));
	if (members.length > 1) {
		const anchor = slots.find((slot) => slot.id === members[0])!;
		const active = storage.getItem("loom.layout.tab") ?? members[0];
		const group = { ...anchor, tabs: members, active: members.includes(active) ? active : members[0], weight: slots.filter((slot) => members.includes(slot.id)).reduce((sum, slot) => sum + slot.weight, 0) };
		slots = slots.flatMap((slot) => slot.id === anchor.id ? [group] : members.includes(slot.id) ? [] : [slot]);
		opened.push(...members);
	}
	return reconcilePanels({ version: 1, slots, opened: unique(opened) }, registrations);
}

export type PanelMove = { kind: "panel"; id: PanelId } | { kind: "slot"; id: string };
export type PanelDrop =
	| { kind: "place"; place: PanelPlace }
	| { kind: "join"; target: string }
	| { kind: "split"; target: string; edge: "top" | "bottom" }
	| { kind: "band"; place: PanelPlace; promote: readonly string[]; promotedPlace: PanelPlace };

/** Detach a tab without losing any other slot/group or the saved floating rectangle. */
export function extractPanel(state: PanelLayoutState, move: PanelMove): { state: PanelLayoutState; slot: PanelSlot } | undefined {
	const source = move.kind === "slot" ? state.slots.find((slot) => slot.id === move.id) : slotFor(state, move.id);
	if (!source) return undefined;
	if (move.kind === "slot" || source.tabs.length === 1) return { state: { ...state, slots: state.slots.filter((slot) => slot !== source) }, slot: source };
	const tabs = source.tabs.filter((id) => id !== move.id);
	let id = move.id;
	while (state.slots.some((slot) => slot.id === id)) id += ":slot";
	const remaining = { ...source, tabs, active: tabs.includes(source.active) ? source.active : tabs[0], weight: source.weight * tabs.length / source.tabs.length };
	return {
		state: { ...state, slots: state.slots.map((slot) => slot === source ? remaining : slot) },
		slot: { ...source, id, tabs: [move.id], active: move.id, weight: source.weight / source.tabs.length },
	};
}

/** One identity-independent operation for Chat, Details, Grade, and future panels. */
export function movePanel(state: PanelLayoutState, move: PanelMove, drop: PanelDrop): PanelLayoutState {
	const extracted = extractPanel(state, move);
	if (!extracted) return state;
	const base = extracted.state;
	const moving = extracted.slot;
	if (drop.kind === "join" || drop.kind === "split") {
		const target = base.slots.find((slot) => slot.id === drop.target);
		if (!target) return state;
		if (drop.kind === "join") {
			const joined = { ...target, tabs: [...target.tabs, ...moving.tabs], active: moving.active, weight: target.weight + moving.weight };
			return { ...base, slots: base.slots.map((slot) => slot === target ? joined : slot) };
		}
		if (target.place.mode === "float") {
			const { height, y } = target.place;
			const upper = { ...target.place, height: height / 2 };
			const lower = { ...upper, y: y + height / 2 };
			const pair = drop.edge === "top" ? [{ ...moving, place: upper }, { ...target, place: lower }] : [{ ...target, place: upper }, { ...moving, place: lower }];
			return { ...base, slots: base.slots.flatMap((slot) => slot === target ? pair : [slot]) };
		}
		const pair = drop.edge === "top"
			? [{ ...moving, place: target.place, weight: target.weight / 2 }, { ...target, weight: target.weight / 2 }]
			: [{ ...target, weight: target.weight / 2 }, { ...moving, place: target.place, weight: target.weight / 2 }];
		return { ...base, slots: base.slots.flatMap((slot) => slot === target ? pair : [slot]) };
	}
	const slots = drop.kind === "band" ? base.slots.map((slot) => drop.promote.includes(slot.id) ? { ...slot, place: drop.promotedPlace } : slot) : base.slots;
	return { ...base, slots: [...slots, { ...moving, place: drop.place }] };
}

export function focusPanel(state: PanelLayoutState, id: PanelId, registrations: readonly PanelRegistration[]): PanelLayoutState {
	const registration = registrations.find((panel) => panel.id === id);
	let next = state;
	if (registration?.firstOpen && !state.opened.includes(id)) {
		const initial = registration.firstOpen;
		const targetId = initial.join?.find((candidate) => registrations.some((panel) => panel.id === candidate && panel.visible) && slotFor(state, candidate)?.place.mode === initial.place.mode);
		const target = targetId && slotFor(state, targetId);
		next = movePanel(state, { kind: "panel", id }, target ? { kind: "join", target: target.id } : { kind: "place", place: initial.place });
	}
	return { ...next, opened: unique([...next.opened, id]), slots: next.slots.map((slot) => slot.tabs.includes(id) ? { ...slot, active: id } : slot) };
}

export function reorderTabs(slot: PanelSlot, visible: readonly PanelId[], ordered: readonly PanelId[]): PanelSlot {
	const queue = [...ordered];
	return { ...slot, tabs: slot.tabs.map((id) => visible.includes(id) ? queue.shift() ?? id : id) };
}

export function resizeSlots(state: PanelLayoutState, upper: string, lower: string, ratio: number): PanelLayoutState {
	const a = state.slots.find((slot) => slot.id === upper), b = state.slots.find((slot) => slot.id === lower);
	if (!a || !b) return state;
	const fraction = Math.max(0.2, Math.min(0.8, ratio));
	const total = a.weight + b.weight;
	return { ...state, slots: state.slots.map((slot) => slot === a ? { ...slot, weight: total * fraction } : slot === b ? { ...slot, weight: total * (1 - fraction) } : slot) };
}

export function slotWeights(slots: readonly PanelSlot[]): Map<string, number> {
	const total = slots.reduce((sum, slot) => sum + slot.weight, 0);
	return new Map(slots.map((slot) => [slot.id, total > 0 ? slot.weight / total : 0]));
}

export function relativeRect(box: { left: number; top: number; width: number; height: number }, bounds: { left: number; top: number }): FloatRect {
	return { x: box.left - bounds.left, y: box.top - bounds.top, width: box.width, height: box.height };
}

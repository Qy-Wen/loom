import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	bottomBand,
	clampFloat,
	type FloatRect,
	MIN_PANEL_HEIGHT,
	pointerNearLowerBand,
	type PanelPlace,
	pointerDocks,
	pointerInside,
	pointerOnLeftEdge,
	pointerOnTopEdge,
} from "./panel-geometry.ts";

export type PanelId = "agent" | "details" | "grade";
type ResizeEdge = "right" | "bottom" | "corner";

interface TabReorder {
	id: PanelId;
	insertX: number | null;
	next: PanelId[] | null;
}

interface DragState {
	id: PanelId;
	rect: FloatRect;
	dock: boolean;
	lower: FloatRect | null;
	join: PanelId | null;
	joinFrame: FloatRect | null;
	splice: { mode: "beside" | "above"; frame: FloatRect } | null;
	group: boolean;
}

const PLACE_KEY: Record<PanelId, string> = {
	agent: "loom.layout.agentPlace",
	details: "loom.layout.detailsPlace",
	grade: "loom.layout.gradePlace",
};
const SPLIT_KEY = "loom.layout.dockSplit";
const BOTTOM_KEY = "loom.layout.bottomHeight";
const ABOVE_KEY = "loom.layout.aboveHeight";
const JOINED_KEY = "loom.layout.joined";
const MEMBERS_KEY = "loom.layout.members";
const TAB_KEY = "loom.layout.tab";
const TAB_ORDER_KEY = "loom.layout.tabOrder";
const PANELS_COLLAPSED_KEY = "loom.layout.panelsCollapsed";
const PANEL_IDS: readonly PanelId[] = ["agent", "details", "grade"];

function isPanelId(value: string): value is PanelId {
	return value === "agent" || value === "details" || value === "grade";
}

function readTabOrder(): [PanelId, PanelId] {
	return localStorage.getItem(TAB_ORDER_KEY) === "details,agent" ? ["details", "agent"] : ["agent", "details"];
}

function readMembers(): PanelId[] {
	const raw = localStorage.getItem(MEMBERS_KEY);
	if (raw != null) {
		const ids = [...new Set(raw.split(",").filter(isPanelId))];
		return ids.length >= 2 ? ids : [];
	}
	return localStorage.getItem(JOINED_KEY) === "1" ? [...readTabOrder()] : [];
}

/** Dropping `dragged` onto `target` adds it to that panel's tab group. */
export function joinMembers(members: readonly PanelId[], dragged: PanelId, target: PanelId): PanelId[] {
	if (dragged === target) return [...members];
	const remaining = members.filter((id) => id !== dragged);
	const base = remaining.includes(target) ? remaining : [target];
	return base.includes(dragged) ? [...base] : [...base, dragged];
}

/** Dropping a whole tab group onto `target` keeps every member and adds that panel. */
export function joinGroup(members: readonly PanelId[], target: PanelId): PanelId[] {
	if (members.includes(target)) return [...members];
	return [target, ...members];
}

/** Drop `id` where the pointer sits. Boxes line up with `order`. An unchanged list means the pointer has not crossed a new slot. */
export function placeTab(
	order: readonly PanelId[],
	id: PanelId,
	clientX: number,
	boxes: readonly { left: number; right: number }[],
): PanelId[] {
	if (!order.includes(id) || boxes.length !== order.length) return [...order];
	const rest = order.filter((item) => item !== id);
	let at = rest.length;
	for (let index = 0; index < rest.length; index++) {
		const box = boxes[order.indexOf(rest[index])];
		if (clientX < box.left + (box.right - box.left) / 2) {
			at = index;
			break;
		}
	}
	return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** The tab that should stay selected after `detached` leaves the group. */
export function tabAfterDetach(
	tab: PanelId,
	members: readonly PanelId[],
	detached: PanelId,
	gradeVisible: boolean,
): PanelId {
	if (tab !== detached && members.includes(tab) && (tab !== "grade" || gradeVisible)) return tab;
	const rest = members.filter((id) => id !== detached && (id !== "grade" || gradeVisible));
	return rest[0] ?? tab;
}

/** Rewrite the visible tabs and leave a hidden member in its current slot. */
export function mergeTabOrder(
	members: readonly PanelId[],
	visible: readonly PanelId[],
	placed: readonly PanelId[],
): PanelId[] {
	const queue = [...placed];
	const shown = new Set(visible);
	return members.map((item) => (shown.has(item) ? queue.shift() ?? item : item));
}

function readPlace(id: PanelId): PanelPlace {
	const stored = readStoredPlace(id);
	if (stored) return stored;
	return id === "grade" ? defaultGradePlace() : { mode: "dock" };
}

function readStoredPlace(id: PanelId): PanelPlace | null {
	try {
		const raw = JSON.parse(localStorage.getItem(PLACE_KEY[id]) ?? "") as Partial<FloatRect> & { mode?: string };
		if (raw.mode === "dock" || raw.mode === "bottom" || raw.mode === "beside" || raw.mode === "above") return { mode: raw.mode };
		if (
			raw.mode === "float"
			&& typeof raw.x === "number"
			&& typeof raw.y === "number"
			&& typeof raw.width === "number"
			&& typeof raw.height === "number"
		) {
			return { mode: "float", x: raw.x, y: raw.y, width: raw.width, height: raw.height };
		}
	} catch {
		// A missing or old value stays docked.
	}
	return null;
}

/** First open sits on the right of the picture, clear of a docked sidebar. */
function defaultGradePlace(): PanelPlace {
	const width = 300;
	const sideOpen = (readStoredPlace("agent") ?? { mode: "dock" }).mode === "dock"
		|| (readStoredPlace("details") ?? { mode: "dock" }).mode === "dock";
	const storedSide = Number(localStorage.getItem("loom.layout.sideWidth"));
	const side = sideOpen ? (Number.isFinite(storedSide) ? storedSide : 360) : 0;
	const height = Math.min(Math.max(window.innerHeight - 36, MIN_PANEL_HEIGHT), 860);
	return {
		mode: "float",
		x: Math.max(12, window.innerWidth - side - width - (side > 0 ? 28 : 20)),
		y: 12,
		width,
		height,
	};
}

function readBottom(): number {
	const value = Number(localStorage.getItem(BOTTOM_KEY));
	if (!Number.isFinite(value)) return 340;
	return Math.min(640, Math.max(160, value));
}

function readAbove(): number {
	const value = Number(localStorage.getItem(ABOVE_KEY));
	if (!Number.isFinite(value)) return 220;
	return Math.min(640, Math.max(160, value));
}

function readSplit(): number {
	const value = Number(localStorage.getItem(SPLIT_KEY));
	if (!Number.isFinite(value)) return 0.5;
	return Math.min(0.72, Math.max(0.28, value));
}

/** Docked or floating placement for Agent, Details, and the grade controls. */
export function usePanelLayout(shellRef: RefObject<HTMLDivElement | null>, gradeVisible = false): {
	place: (id: PanelId) => PanelPlace;
	style: (id: PanelId) => CSSProperties;
	anyDocked: boolean;
	anyBottom: boolean;
	anyBeside: boolean;
	anyAbove: boolean;
	bothDocked: boolean;
	bothBottom: boolean;
	bothBeside: boolean;
	bothAbove: boolean;
	bottomHeight: number;
	aboveHeight: number;
	dragDock: boolean;
	lowerFrame: FloatRect | null;
	joined: boolean;
	members: PanelId[];
	tab: PanelId;
	tabOrder: PanelId[];
	tabReorder: TabReorder | null;
	joinTarget: PanelId | null;
	joinFrame: FloatRect | null;
	spliceFrame: FloatRect | null;
	groupDrag: boolean;
	groupStyle: () => CSSProperties | undefined;
	isSnapping: (id: PanelId) => boolean;
	focus: (id: PanelId) => void;
	beginDrag: (id: PanelId, event: ReactPointerEvent<HTMLElement>) => void;
	beginTabDrag: (id: PanelId, event: ReactPointerEvent<HTMLElement>) => void;
	beginGroupDrag: (event: ReactPointerEvent<HTMLElement>) => void;
	beginResize: (id: PanelId, edge: ResizeEdge, event: ReactPointerEvent<HTMLElement>) => void;
	beginDockSplit: (event: ReactPointerEvent<HTMLElement>) => void;
	beginBottomResize: (event: ReactPointerEvent<HTMLElement>) => void;
	beginAboveResize: (event: ReactPointerEvent<HTMLElement>) => void;
	panelsCollapsed: boolean;
	togglePanelsCollapsed: () => void;
} {
	const [members, setMembers] = useState<PanelId[]>(readMembers);
	const [panelsCollapsed, setPanelsCollapsed] = useState(() => localStorage.getItem(PANELS_COLLAPSED_KEY) === "1");
	const membersRef = useRef(members);
	membersRef.current = members;
	const [places, setPlaces] = useState<Record<PanelId, PanelPlace>>(() => {
		const next = {
			agent: readPlace("agent"),
			details: readPlace("details"),
			grade: readPlace("grade"),
		};
		const grouped = readMembers();
		if (grouped.length >= 2) {
			const anchor = next[grouped[0]];
			for (const id of grouped) next[id] = anchor;
		}
		return next;
	});
	const [split, setSplit] = useState(readSplit);
	const [bottomHeight, setBottomHeight] = useState(readBottom);
	const [aboveHeight, setAboveHeight] = useState(readAbove);
	const [tab, setTab] = useState<PanelId>(() => {
		const grouped = readMembers();
		const stored = localStorage.getItem(TAB_KEY);
		if (stored && isPanelId(stored) && (grouped.length < 2 || grouped.includes(stored))) return stored;
		return grouped[0] ?? "agent";
	});
	const [tabReorder, setTabReorder] = useState<TabReorder | null>(null);
	const tabReorderRef = useRef<TabReorder | null>(null);
	const [z, setZ] = useState<Record<PanelId, number>>({ agent: 2, details: 1, grade: 3 });
	const zRef = useRef(z);
	zRef.current = z;
	const gradeVisibleRef = useRef(gradeVisible);
	gradeVisibleRef.current = gradeVisible;
	const joined = members.length >= 2;
	const [drag, setDrag] = useState<DragState | null>(null);

	useEffect(() => {
		localStorage.setItem(PLACE_KEY.agent, JSON.stringify(places.agent));
		localStorage.setItem(PLACE_KEY.details, JSON.stringify(places.details));
		localStorage.setItem(PLACE_KEY.grade, JSON.stringify(places.grade));
	}, [places]);

	useEffect(() => {
		localStorage.setItem(SPLIT_KEY, String(split));
	}, [split]);

	useEffect(() => {
		localStorage.setItem(BOTTOM_KEY, String(bottomHeight));
	}, [bottomHeight]);

	useEffect(() => {
		localStorage.setItem(ABOVE_KEY, String(aboveHeight));
	}, [aboveHeight]);

	useEffect(() => {
		localStorage.setItem(MEMBERS_KEY, members.join(","));
		localStorage.setItem(JOINED_KEY, members.length >= 2 ? "1" : "0");
		if (members.length === 2 && members.includes("agent") && members.includes("details")) {
			localStorage.setItem(TAB_ORDER_KEY, members.join(","));
		}
	}, [members]);

	useEffect(() => {
		localStorage.setItem(TAB_KEY, tab);
	}, [tab]);

	useEffect(() => {
		if (gradeVisible || tab !== "grade") return;
		const next = members.find((id) => id !== "grade");
		if (next) setTab(next);
	}, [gradeVisible, members, tab]);

	useEffect(() => {
		const shell = shellRef.current;
		if (!shell) return;
		const observer = new ResizeObserver(() => {
			const bounds = shell.getBoundingClientRect();
			setPlaces((current) => {
				let changed = false;
				const next = { ...current };
				for (const id of ["agent", "details", "grade"] as const) {
					const place = current[id];
					if (place.mode !== "float") continue;
					const clamped = clampFloat(place, bounds);
					if (clamped.x !== place.x || clamped.y !== place.y || clamped.width !== place.width || clamped.height !== place.height) {
						next[id] = { mode: "float", ...clamped };
						changed = true;
					}
				}
				return changed ? next : current;
			});
		});
		observer.observe(shell);
		return () => observer.disconnect();
	}, [shellRef]);

	function togglePanelsCollapsed(): void {
		setPanelsCollapsed((current) => {
			const next = !current;
			localStorage.setItem(PANELS_COLLAPSED_KEY, next ? "1" : "0");
			return next;
		});
	}

	function focus(id: PanelId): void {
		if (membersRef.current.includes(id)) setTab(id);
		setZ((current) => {
			const top = Math.max(current.agent, current.details, current.grade);
			if (current[id] === top) return current;
			return { ...current, [id]: top + 1 };
		});
	}

	function panelUnder(skip: ReadonlySet<PanelId>, clientX: number, clientY: number): PanelId | null {
		let hit: PanelId | null = null;
		let layer = -1;
		for (const other of PANEL_IDS) {
			if (skip.has(other) || (other === "grade" && !gradeVisibleRef.current)) continue;
			const element = document.querySelector(`.work-panel[data-panel="${other}"]`);
			if (!(element instanceof HTMLElement)) continue;
			const box = element.getBoundingClientRect();
			if (box.width < 1 || box.height < 1) continue;
			if (!pointerInside(clientX, clientY, box)) continue;
			if (zRef.current[other] < layer) continue;
			layer = zRef.current[other];
			hit = other;
		}
		return hit;
	}

	function panelFrame(id: PanelId, bounds: DOMRect): FloatRect | null {
		const panel = document.querySelector(`.work-panel[data-panel="${id}"]`);
		if (!(panel instanceof HTMLElement)) return null;
		const box = columnBox(panel);
		return {
			x: box.left - bounds.left,
			y: box.top - bounds.top,
			width: box.width,
			height: box.height,
		};
	}

	function place(id: PanelId): PanelPlace {
		if (drag?.id === id && !drag.group) return { mode: "float", ...drag.rect };
		return places[id];
	}

	function spliceTarget(
		id: PanelId,
		clientX: number,
		clientY: number,
		group: boolean,
		bounds: DOMRect,
	): { mode: "beside" | "above"; frame: FloatRect } | null {
		const skip = new Set(group ? membersRef.current : [id]);
		let dockBox: DOMRect | null = null;
		let bottomBox: DOMRect | null = null;
		let lowerBox: DOMRect | null = null;
		let besideBox: DOMRect | null = null;
		let aboveBox: DOMRect | null = null;
		for (const other of PANEL_IDS) {
			if (skip.has(other) || (other === "grade" && !gradeVisibleRef.current)) continue;
			const element = document.querySelector(`.work-panel[data-panel="${other}"]`);
			if (!(element instanceof HTMLElement)) continue;
			const box = columnBox(element);
			if (box.width < 1 || box.height < 1) continue;
			const mode = places[other].mode;
			if (mode === "dock" && pointerOnLeftEdge(clientX, clientY, box) && (!dockBox || box.height > dockBox.height)) dockBox = box;
			if (mode === "bottom" && (!lowerBox || box.width > lowerBox.width)) lowerBox = box;
			if (mode === "bottom" && pointerOnTopEdge(clientX, clientY, box) && (!bottomBox || box.width > bottomBox.width)) bottomBox = box;
			if (mode === "beside") besideBox = box;
			if (mode === "above") aboveBox = box;
		}
		const shell = shellRef.current;
		if (dockBox && shell) {
			const width = readCssPx(shell, "--beside-width", 300);
			const height = lowerBox ? Math.max(120, lowerBox.top - dockBox.top) : dockBox.height;
			const frame = besideBox ? relativeFrame(besideBox, bounds) : {
				x: dockBox.left - bounds.left - width,
				y: dockBox.top - bounds.top,
				width,
				height,
			};
			return { mode: "beside", frame };
		}
		if (bottomBox) {
			const frame = aboveBox ? relativeFrame(aboveBox, bounds) : {
				x: bottomBox.left - bounds.left,
				y: bottomBox.top - bounds.top - aboveHeight,
				width: bottomBox.width,
				height: aboveHeight,
			};
			return { mode: "above", frame };
		}
		return null;
	}

	function beginDrag(
		id: PanelId,
		event: ReactPointerEvent<HTMLElement> | PointerEvent,
		kind: "panel" | "tab" | "group" = "panel",
		source?: HTMLElement,
		immediate = false,
	): void {
		if (!immediate && event.button !== 0) return;
		const handle = source ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
		const shell = shellRef.current;
		const panel = handle && ((kind === "group" || (kind === "tab" && joined))
			? handle.closest(".side-stack")
			: handle.closest(".work-panel"));
		if (!shell || !(panel instanceof HTMLElement)) return;
		event.preventDefault();
		event.stopPropagation();
		if (kind !== "group") focus(id);
		const origin = panel.getBoundingClientRect();
		const shellOrigin = shell.getBoundingClientRect();
		const grabX = event.clientX - origin.left;
		const startX = event.clientX;
		const startY = event.clientY;
		let grabY = event.clientY - origin.top;
		let width = origin.width;
		let height = origin.height;
		const canReturnToDock = places[id].mode === "float" || places[id].mode === "bottom";
		let moved = false;
		let rect: FloatRect = {
			x: origin.left - shellOrigin.left,
			y: origin.top - shellOrigin.top,
			width,
			height,
		};
		let dockHit = false;
		let lowerHit: FloatRect | null = null;
		let joinHit: PanelId | null = null;
		let spliceHit: { mode: "beside" | "above"; frame: FloatRect } | null = null;
		const group = kind === "group";
		const activeTab = tab;
		// A tab drag starts inside the joined window. Rejoin only after the pointer has left it,
		// so the same gesture can pull a tab out and drop it back.
		let joinArmed = kind !== "tab";
		const originBox = origin;

		const engage = (bounds: DOMRect) => {
			moved = true;
			document.body.classList.add("dragging-panel");
			if (kind === "tab" && membersRef.current.includes(id)) {
				const previous = membersRef.current;
				const next = previous.filter((member) => member !== id);
				const resolved = next.length >= 2 ? next : [];
				membersRef.current = resolved;
				setMembers(resolved);
				setTab(tabAfterDetach(activeTab, previous, id, gradeVisibleRef.current));
			}
			if (height > bounds.height * 0.62) {
				height = Math.max(MIN_PANEL_HEIGHT, Math.round(bounds.height * 0.55));
				grabY = Math.min(grabY, height - 24);
			}
		};

		const onMove = (move: PointerEvent) => {
			const bounds = shell.getBoundingClientRect();
			if (!moved) {
				if (Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
				engage(bounds);
			}
			const free = clampFloat({
				x: move.clientX - bounds.left - grabX,
				y: move.clientY - bounds.top - grabY,
				width,
				height,
			}, bounds);
			if (!joinArmed && !pointerInside(move.clientX, move.clientY, originBox)) joinArmed = true;
			spliceHit = joinArmed ? spliceTarget(id, move.clientX, move.clientY, group, bounds) : null;
			const skip = new Set(group ? membersRef.current : [id]);
			joinHit = spliceHit || !joinArmed ? null : panelUnder(skip, move.clientX, move.clientY);
			dockHit = !spliceHit && !joinHit && pointerDocks(move.clientX, bounds.right);
			const metrics = readShellMetrics(shell);
			const sideInset = group || !otherDocked(id, places, gradeVisibleRef.current) ? 0 : metrics.side;
			const slot = bottomBand(bounds, metrics.library, sideInset, bottomHeight);
			lowerHit = !spliceHit && !joinHit && !dockHit && pointerNearLowerBand(move.clientX - bounds.left, move.clientY - bounds.top, slot) ? slot : null;
			rect = lowerHit ?? free;
			setDrag({
				id,
				rect,
				dock: dockHit,
				lower: lowerHit,
				join: joinHit,
				joinFrame: joinHit ? panelFrame(joinHit, bounds) : null,
				splice: spliceHit,
				group,
			});
		};

		const onUp = (up: PointerEvent) => {
			document.body.classList.remove("dragging-panel");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			setDrag(null);
			if (!moved) {
				if (kind === "tab") setTab(id);
				else if ((group || canReturnToDock) && up.detail >= 2) {
					const dock = { mode: "dock" } as const;
					setPlaces((current) => group ? sharePlace(current, membersRef.current, dock) : { ...current, [id]: dock });
				}
				return;
			}
			if (joinHit) {
				const nextMembers = group
					? joinGroup(membersRef.current, joinHit)
					: joinMembers(membersRef.current, id, joinHit);
				const shared = places[joinHit];
				membersRef.current = nextMembers;
				setMembers(nextMembers);
				setTab(group && nextMembers.includes(activeTab) ? activeTab : id);
				setPlaces((current) => sharePlace(current, nextMembers, shared));
				return;
			}
			const bounds = shell.getBoundingClientRect();
			const next: PanelPlace = spliceHit
				? { mode: spliceHit.mode }
				: dockHit
					? { mode: "dock" }
					: lowerHit
						? { mode: "bottom" }
						: { mode: "float", ...clampFloat(rect, bounds) };
			setPlaces((current) => group ? sharePlace(current, membersRef.current, next) : { ...current, [id]: next });
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		if (immediate) {
			engage(shell.getBoundingClientRect());
			onMove(event instanceof PointerEvent ? event : new PointerEvent("pointermove"));
		}
	}

	function beginTabDrag(id: PanelId, event: ReactPointerEvent<HTMLElement>): void {
		if (event.button !== 0) return;
		const bar = event.currentTarget.closest(".panel-tabs");
		if (!(bar instanceof HTMLElement) || !joined) {
			beginDrag(id, event, "tab");
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const originX = event.clientX;
		const originY = event.clientY;
		const source = event.currentTarget;

		const showReorder = (next: TabReorder | null) => {
			const current = tabReorderRef.current;
			if (
				current?.id === next?.id
				&& current?.insertX === next?.insertX
				&& (current?.next?.join() ?? "") === (next?.next?.join() ?? "")
			) return;
			tabReorderRef.current = next;
			setTabReorder(next);
		};

		const onMove = (move: PointerEvent) => {
			if (Math.hypot(move.clientX - originX, move.clientY - originY) < 4) return;
			const barBox = bar.getBoundingClientRect();
			const outside = move.clientY < barBox.top - 8
				|| move.clientY > barBox.bottom + 8
				|| move.clientX < barBox.left - 12
				|| move.clientX > barBox.right + 12;
			if (outside) {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				showReorder(null);
				beginDrag(id, move, "tab", source, true);
				return;
			}
			const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button[data-tab]")];
			if (buttons.length < 2) return;
			const visible = buttons.flatMap((button) => {
				const tabId = button.dataset.tab;
				return tabId && isPanelId(tabId) ? [tabId] : [];
			});
			if (visible.length !== buttons.length || !visible.includes(id)) return;
			const boxes = buttons.map((button) => {
				const box = button.getBoundingClientRect();
				return { left: box.left, right: box.right };
			});
			const placed = placeTab(visible, id, move.clientX, boxes);
			const changed = placed.some((tabId, index) => tabId !== visible[index]);
			let insertX: number | null = null;
			if (changed) {
				const at = placed.indexOf(id);
				const neighbor = at === 0 ? placed[1] : placed[at - 1];
				const edge = boxes[visible.indexOf(neighbor)];
				insertX = (at === 0 ? edge.left : edge.right) - barBox.left;
			}
			showReorder({
				id,
				insertX,
				next: changed ? mergeTabOrder(membersRef.current, visible, placed) : null,
			});
		};

		const onUp = (up: PointerEvent) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			const next = tabReorderRef.current?.next ?? null;
			showReorder(null);
			if (next) {
				membersRef.current = next;
				setMembers(next);
				return;
			}
			if (Math.hypot(up.clientX - originX, up.clientY - originY) < 4) setTab(id);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	function beginGroupDrag(event: ReactPointerEvent<HTMLElement>): void {
		beginDrag(membersRef.current[0] ?? "agent", event, "group");
	}

	function beginResize(id: PanelId, edge: ResizeEdge, event: ReactPointerEvent<HTMLElement>): void {
		if (event.button !== 0) return;
		const shell = shellRef.current;
		const current = places[id];
		if (!shell || current.mode !== "float") return;
		event.preventDefault();
		event.stopPropagation();
		if (!joined) focus(id);
		const startX = event.clientX;
		const startY = event.clientY;
		const origin = current;
		document.body.classList.add("resizing-panel");

		const onMove = (move: PointerEvent) => {
			const bounds = shell.getBoundingClientRect();
			const next = clampFloat({
				x: origin.x,
				y: origin.y,
				width: origin.width + (edge === "bottom" ? 0 : move.clientX - startX),
				height: origin.height + (edge === "right" ? 0 : move.clientY - startY),
			}, bounds);
			const resized = { mode: "float" as const, ...next };
			setPlaces((placesNow) => {
				const grouped = membersRef.current;
				return grouped.includes(id) && grouped.length >= 2
					? sharePlace(placesNow, grouped, resized)
					: { ...placesNow, [id]: resized };
			});
		};

		const onUp = () => {
			document.body.classList.remove("resizing-panel");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	function beginBottomResize(event: ReactPointerEvent<HTMLElement>): void {
		const shell = shellRef.current;
		if (event.button !== 0 || !shell) return;
		event.preventDefault();
		const bounds = shell.getBoundingClientRect();
		document.body.classList.add("resizing-rows");

		const onMove = (move: PointerEvent) => {
			setBottomHeight(Math.min(bounds.height - 180, Math.max(160, bounds.bottom - move.clientY)));
		};

		const onUp = () => {
			document.body.classList.remove("resizing-rows");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	function beginAboveResize(event: ReactPointerEvent<HTMLElement>): void {
		const shell = shellRef.current;
		if (event.button !== 0 || !shell) return;
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = aboveHeight;
		const bounds = shell.getBoundingClientRect();
		document.body.classList.add("resizing-rows");

		const onMove = (move: PointerEvent) => {
			setAboveHeight(Math.min(bounds.height - 180, Math.max(160, startHeight + startY - move.clientY)));
		};

		const onUp = () => {
			document.body.classList.remove("resizing-rows");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	function beginDockSplit(event: ReactPointerEvent<HTMLElement>): void {
		const stack = event.currentTarget.parentElement;
		if (event.button !== 0 || !stack) return;
		event.preventDefault();
		const bounds = stack.getBoundingClientRect();
		document.body.classList.add("resizing-rows");

		const onMove = (move: PointerEvent) => {
			const ratio = (move.clientY - bounds.top) / bounds.height;
			setSplit(Math.min(0.72, Math.max(0.28, ratio)));
		};

		const onUp = () => {
			document.body.classList.remove("resizing-rows");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	const agentPlace = place("agent");
	const detailsPlace = place("details");
	const gradePlace = gradeVisible ? place("grade") : null;
	const bothDocked = agentPlace.mode === "dock" && detailsPlace.mode === "dock";
	const anyDocked = agentPlace.mode === "dock" || detailsPlace.mode === "dock" || gradePlace?.mode === "dock";
	const bothBottom = agentPlace.mode === "bottom" && detailsPlace.mode === "bottom";
	const anyBottom = agentPlace.mode === "bottom" || detailsPlace.mode === "bottom" || gradePlace?.mode === "bottom";
	const bothBeside = agentPlace.mode === "beside" && detailsPlace.mode === "beside";
	const anyBeside = agentPlace.mode === "beside" || detailsPlace.mode === "beside" || gradePlace?.mode === "beside";
	const bothAbove = agentPlace.mode === "above" && detailsPlace.mode === "above";
	const anyAbove = agentPlace.mode === "above" || detailsPlace.mode === "above" || gradePlace?.mode === "above";
	function style(id: PanelId): CSSProperties {
		const draggingThis = drag?.id === id && !drag.group;
		if ((members.includes(id) || (drag?.group && members.includes(id))) && !draggingThis) return {};
		const shown = place(id);
		if (shown.mode === "float") {
			return {
				left: shown.x,
				top: shown.y,
				width: shown.width,
				height: shown.height,
				zIndex: 8 + z[id],
			};
		}
		if (
			(shown.mode === "bottom" && bothBottom)
			|| (shown.mode === "beside" && bothBeside)
			|| (shown.mode === "above" && bothAbove)
		) {
			return { flexGrow: id === "grade" ? 1 : id === "agent" ? split : 1 - split, flexBasis: 0 };
		}
		if (shown.mode === "bottom" || shown.mode === "beside" || shown.mode === "above" || (shown.mode === "dock" && (anyBottom || anyBeside || anyAbove))) return {};
		if (id === "grade") return { flexGrow: 1, flexBasis: 0 };
		return { flexGrow: bothDocked ? (id === "agent" ? split : 1 - split) : 1, flexBasis: 0 };
	}

	function groupStyle(): CSSProperties | undefined {
		const anchor = members[0];
		if (!anchor) return undefined;
		if (drag?.group) return { left: drag.rect.x, top: drag.rect.y, width: drag.rect.width, height: drag.rect.height };
		const shared = places[anchor];
		if (shared.mode !== "float") return undefined;
		return {
			left: shared.x,
			top: shared.y,
			width: shared.width,
			height: shared.height,
			zIndex: 8 + Math.max(...members.map((id) => z[id])),
		};
	}

	return {
		place,
		style,
		anyDocked,
		anyBottom,
		anyBeside,
		anyAbove,
		bothDocked,
		bothBottom,
		bothBeside,
		bothAbove,
		bottomHeight,
		aboveHeight,
		dragDock: drag?.dock ?? false,
		lowerFrame: drag?.lower ?? null,
		joined,
		members,
		tab,
		tabOrder: members.filter((id) => id !== "grade" || gradeVisible),
		tabReorder,
		joinTarget: drag?.join ?? null,
		joinFrame: drag?.joinFrame ?? null,
		spliceFrame: drag?.splice?.frame ?? null,
		groupDrag: drag?.group ?? false,
		groupStyle,
		isSnapping: (id) => drag?.id === id && !drag.group && (drag.dock || drag.lower !== null),
		focus,
		beginDrag,
		beginTabDrag,
		beginGroupDrag,
		beginResize,
		beginDockSplit,
		beginBottomResize,
		beginAboveResize,
		panelsCollapsed,
		togglePanelsCollapsed,
	};
}

function sharePlace(
	current: Record<PanelId, PanelPlace>,
	ids: readonly PanelId[],
	next: PanelPlace,
): Record<PanelId, PanelPlace> {
	const updated = { ...current };
	for (const id of ids) updated[id] = next;
	return updated;
}

function otherDocked(id: PanelId, places: Record<PanelId, PanelPlace>, gradeVisible: boolean): boolean {
	const docked = (panel: PanelId) => places[panel].mode === "dock" && (panel !== "grade" || gradeVisible);
	if (id === "grade") return docked("agent") || docked("details");
	return docked(id === "agent" ? "details" : "agent") || docked("grade");
}

function readShellMetrics(shell: HTMLElement): { library: number; side: number; beside: number } {
	const style = getComputedStyle(shell);
	const library = Number.parseFloat(style.getPropertyValue("--library-width"));
	const side = Number.parseFloat(style.getPropertyValue("--side-width"));
	const beside = shell.querySelector(".beside-resize") ? readCssPx(shell, "--beside-width", 0) : 0;
	return {
		library: Number.isFinite(library) ? library : 0,
		side: Number.isFinite(side) ? side : 0,
		beside,
	};
}

function readCssPx(shell: HTMLElement, name: string, fallback: number): number {
	const value = Number.parseFloat(getComputedStyle(shell).getPropertyValue(name));
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A joined column's tab bar sits above the work panel. Snap to the whole column, title included. */
function columnBox(panel: HTMLElement): DOMRect {
	const stack = panel.closest(".side-stack");
	if (!(stack instanceof HTMLElement) || stack.classList.contains("spread") || stack.classList.contains("floating")) {
		return panel.getBoundingClientRect();
	}
	const box = stack.getBoundingClientRect();
	return box.width > 1 && box.height > 1 ? box : panel.getBoundingClientRect();
}

function relativeFrame(box: DOMRect, bounds: DOMRect): FloatRect {
	return {
		x: box.left - bounds.left,
		y: box.top - bounds.top,
		width: box.width,
		height: box.height,
	};
}
